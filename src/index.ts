/**
 * `arkcli` provider extension: ARK `GET /api/v3/models` -> host model rows.
 *
 * omp's built-in `openai-models-list` discovery reads OpenAI-style field names
 * (`context_length`, `input_modalities`, `supported_reasoning_levels`). ARK
 * advertises the same facts under `context_window` / `token_limits`,
 * `modalities.input_modalities`, and `effort.supported_levels`, so every
 * discovered ARK model fell back to 128K context, text-only input, and no
 * thinking ladder. This extension maps the ARK contract directly instead of
 * relying on `modelOverrides`.
 *
 * Verified live: 1M context, image input, and the `low`/`high`/`max` ladder all
 * round-trip through omp once these fields are populated.
 *
 * The same file also serves pi (`@earendil-works/pi-coding-agent`), which loads
 * extensions through the same default-export convention but exposes a different
 * provider contract: `refreshModels(context)` instead of
 * `fetchDynamicModels(apiKey)`, `$ENV_VAR` key references, and
 * `reasoning`+`thinkingLevelMap` instead of a `thinking` ladder. The host is
 * detected from the extension API, so one path serves both.
 */

import {
	ARK_API_KEY_ENV,
	ARK_BASE_URL,
	type ArkModelRow,
	mapArkModels,
	type OmpModelRow,
} from "./ark.ts";
import { modelCacheFile, readModelCache, writeModelCache } from "./cache.ts";
import { fetchArkModels } from "./discovery.ts";
import {
	completePiModel,
	PI_API_KEY_REF,
	PI_CHAT_API,
	PI_IMAGE_API,
	mapArkModelsToPi,
	type PiModelConfig,
	type PiStoredModel,
	restorePiModels,
} from "./pi.ts";
import { generateArkImages } from "./pi-images.ts";

export const PROVIDER_ID = "arkcli";

/** Display name in pi's model picker. */
const PROVIDER_NAME = "Volcengine ARK (火山方舟)";

/** A saved `/login` key wins; the env var is the fallback omp resolves itself. */
const CONFIGURED_KEY_FALLBACK = ARK_API_KEY_ENV;

/**
 * ARK is regional (`ark.cn-beijing.volces.com`, `ark.ap-southeast.bytepluses.com`
 * and so on). `ARK_BASE_URL` selects another endpoint without editing the
 * plugin; unset means cn-beijing.
 */
function resolveBaseUrl(): string {
	const override = process.env.ARK_BASE_URL?.trim();
	return override ? override.replace(/\/+$/, "") : ARK_BASE_URL;
}

/**
 * How long a cached catalog is served without any network attempt. ARK adds
 * model versions rarely; omp's own catalog cache is 2 h and pi's remote-catalog
 * interval is 4 h, so 6 h keeps this extension from being the first thing that
 * blocks a start. `ARKCLI_CACHE_TTL_MS` overrides it (0 forces a refresh on the
 * next interactive start).
 */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function cacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.ARKCLI_CACHE_TTL_MS?.trim();
	if (!raw) return CACHE_TTL_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : CACHE_TTL_MS;
}

/** Bound for a refresh that runs behind an interactive session. */
const BACKGROUND_REFRESH_TIMEOUT_MS = 10_000;

/** A cache miss may wait, but not forever: omp abandons discovery at 15 s anyway. */
const FIRST_RUN_TIMEOUT_MS = 15_000;

/** After a failed attempt, do not make the next start wait again for this long. */
export const NEGATIVE_TTL_MS = 5 * 60 * 1000;

/**
 * One-shot invocations must not keep the event loop alive for a refresh they
 * cannot use: a pending fetch delays process exit until it settles or aborts
 * (measured: `omp models --json` 8.1 s at baseline, 22 s with a 20 s abort).
 */
const ONE_SHOT_FLAGS: Record<string, true> = {
	"-p": true,
	"--print": true,
	"--list-models": true,
	"-v": true,
	"--version": true,
	"-h": true,
	"--help": true,
};

/**
 * A bare word after the binary is a subcommand (`omp models`, `omp doctor`), and
 * subcommands are one-shot even on a terminal: measured argv is
 * `[bun, /…/omp-linux-x64, models, --json, …]` for `omp models --json` and
 * `[bun, /…/omp-linux-x64, -e, …]` for the TUI.
 */
export function isInteractiveSession(
	argv: readonly string[] = process.argv,
	stdoutIsTTY: boolean = process.stdout?.isTTY === true,
): boolean {
	if (!stdoutIsTTY) return false;
	const args = argv.slice(2);
	if (args.some(argument => ONE_SHOT_FLAGS[argument] === true)) return false;
	// `--mode=json|text` runs one turn and exits; the rpc modes stay up.
	if (args.some(argument => argument === "--mode=json" || argument === "--mode=text")) return false;
	const first = args[0];
	return first === undefined || first.startsWith("-");
}

/**
 * `omp models refresh` is documented as "force a fresh catalog fetch (replaces
 * rm -rf ~/.omp/models.db)", so it must bypass this cache too: measured argv is
 * `[bun, /…/omp-linux-x64, models, refresh, …]`.
 */
export function isForcedRefresh(argv: readonly string[] = process.argv): boolean {
	const args = argv.slice(2);
	return args[0] === "models" && args[1] === "refresh";
}

/** One in-flight operation per cache file, so a double discovery call shares it. */
const inFlightRefreshes = new Map<string, Promise<void>>();
const inFlightFetches = new Map<string, Promise<ArkModelRow[]>>();

/**
 * Refresh behind the caller. The promise is intentionally not returned: the
 * host must never await this, and a failure only loses one refresh cycle.
 */
function refreshBehind(
	file: string,
	baseUrl: string,
	apiKey: string,
	warn: (message: string) => void,
	fetchImpl?: typeof globalThis.fetch,
): void {
	if (inFlightRefreshes.has(file)) return;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), BACKGROUND_REFRESH_TIMEOUT_MS);
	const task = (async () => {
		try {
			const rows = await fetchArkModels({ baseUrl, apiKey, signal: controller.signal, fetch: fetchImpl });
			// Never replace a usable catalog with an empty one: the empty entry
			// would be treated as a miss and the next start would block.
			if (rows.length > 0) await writeModelCache(file, { baseUrl, checkedAt: Date.now(), rows });
		} catch (error) {
			if (!controller.signal.aborted) {
				warn(
					`${PROVIDER_ID}: background model refresh failed; keeping the cached catalog. ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		} finally {
			clearTimeout(timer);
			inFlightRefreshes.delete(file);
		}
	})();
	inFlightRefreshes.set(file, task);
}

/** The blocking path: only a cache miss may wait for ARK. */
function fetchOnce(
	file: string,
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal,
	fetchImpl?: typeof globalThis.fetch,
): Promise<ArkModelRow[]> {
	const existing = inFlightFetches.get(file);
	if (existing) return existing;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FIRST_RUN_TIMEOUT_MS);
	const timeout = controller.signal;
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const task = (async () => {
		const rows = await fetchArkModels({ baseUrl, apiKey, signal: combined, fetch: fetchImpl });
		await writeModelCache(file, { baseUrl, checkedAt: Date.now(), rows });
		return rows;
	})().finally(() => {
		clearTimeout(timer);
		inFlightFetches.delete(file);
	});
	inFlightFetches.set(file, task);
	return task;
}

/**
 * Cache-first discovery. The first run for an endpoint+key waits for ARK (there
 * is nothing else to serve); every later run answers from disk and, when the
 * entry is stale, refreshes behind an interactive session only.
 */
async function loadArkRows(options: {
	baseUrl: string;
	apiKey: string;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	warn: (message: string) => void;
	allowNetwork: boolean;
	/** The host asked for a fresh catalog (`omp models refresh`, pi `force`). */
	force?: boolean;
}): Promise<{ rows: ArkModelRow[]; source: "cache" | "network" | "none" }> {
	if (!options.apiKey) return { rows: [], source: "none" };
	const file = modelCacheFile(options.baseUrl, options.apiKey);
	const cached = options.force ? undefined : await readModelCache(file);
	const usable = cached && cached.baseUrl === options.baseUrl && cached.rows.length > 0 ? cached : undefined;
	if (usable) {
		const stale = Date.now() - usable.checkedAt >= cacheTtlMs();
		if (stale && options.allowNetwork && isInteractiveSession()) {
			refreshBehind(file, options.baseUrl, options.apiKey, options.warn, options.fetch);
		}
		return { rows: usable.rows, source: "cache" };
	}

	// An empty or failed entry is not a catalog: retry, but not every start.
	// Without this, an unreachable endpoint costs the full timeout on each start.
	const recentlyFailed =
		cached?.failedAt !== undefined && Date.now() - cached.failedAt < NEGATIVE_TTL_MS;
	if (recentlyFailed) {
		if (options.allowNetwork && isInteractiveSession()) {
			refreshBehind(file, options.baseUrl, options.apiKey, options.warn, options.fetch);
		}
		return { rows: [], source: "none" };
	}
	if (!options.allowNetwork) return { rows: [], source: "none" };
	try {
		return { rows: await fetchOnce(file, options.baseUrl, options.apiKey, options.signal, options.fetch), source: "network" };
	} catch (error) {
		await writeModelCache(file, { baseUrl: options.baseUrl, checkedAt: Date.now(), rows: [], failedAt: Date.now() });
		options.warn(
			`${PROVIDER_ID}: model discovery failed; registering no models for this session. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { rows: [], source: "none" };
	}
}

/** The omp provider contract (`/models` discovery via `fetchDynamicModels`). */
export interface OmpProviderConfig {
	baseUrl: string;
	apiKey: string;
	api: string;
	models?: OmpModelRow[];
	fetchDynamicModels?: (apiKey?: string) => Promise<OmpModelRow[]>;
}

/** pi's `RefreshModelsContext`, limited to what this extension reads. */
export interface PiRefreshContext {
	credential?: { type: string; key?: string };
	stored?: { models?: readonly unknown[] };
	allowNetwork: boolean;
	/** pi sets this when the user forces a refresh; it bypasses freshness checks. */
	force?: boolean;
	signal: AbortSignal;
	publish(publication: { persist?: unknown; update?: () => void }): Promise<boolean>;
}

/** The pi provider contract (`refreshModels` + per-api runners). */
export interface PiProviderConfig {
	name?: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	models?: PiModelConfig[];
	refreshModels?: (context: PiRefreshContext) => Promise<PiModelConfig[]>;
	images?: Record<string, { generateImages: (...args: never[]) => unknown }>;
}

export interface ArkExtensionApi {
	registerProvider(name: string, config: OmpProviderConfig | PiProviderConfig): void;
	/** pi-only; omp has no virtual models. Used to tell the two hosts apart. */
	registerVirtualModel?: unknown;
	logger?: { debug(...args: unknown[]): void; warn(...args: unknown[]): void };
}

/** pi exposes `registerVirtualModel`; omp exposes `logger` and `extension`. */
export function isPiHost(pi: ArkExtensionApi): boolean {
	return typeof pi.registerVirtualModel === "function";
}

/**
 * pi calls `refreshModels` twice per session: once with `allowNetwork: false` to
 * restore the persisted catalog, then — interactive mode only — with
 * `allowNetwork: true`. `--list-models` and `-p` never reach the network phase,
 * so they see whatever the last interactive run persisted. That is pi's own
 * contract for live catalogs (see `withRemoteCatalog`), not a limitation here.
 *
 * Even in the network phase this answers from disk when a catalog exists, so a
 * start never waits on ARK after the first discovery for that key.
 */
async function refreshPiModels(
	context: PiRefreshContext,
	deps: { baseUrl: string; warn(message: string): void },
): Promise<PiModelConfig[]> {
	const stored = restorePiModels(context.stored?.models, PROVIDER_ID);
	if (context.signal.aborted) return stored;

	const apiKey =
		context.credential?.type === "api_key" ? context.credential.key : process.env[ARK_API_KEY_ENV];
	const loaded = await loadArkRows({
		baseUrl: deps.baseUrl,
		apiKey: apiKey ?? "",
		signal: context.signal,
		warn: deps.warn,
		allowNetwork: context.allowNetwork && !context.signal.aborted,
		force: context.force === true,
	});
	if (loaded.source === "none") return stored;

	const models = mapArkModelsToPi(mapArkModels(loaded.rows).models);
	if (loaded.source === "network") {
		const persisted: PiStoredModel[] = models.map(model =>
			completePiModel(model, PROVIDER_ID, deps.baseUrl),
		);
		await context.publish({ persist: { models: persisted, checkedAt: Date.now() } });
	}
	return models;
}

export default function arkcliExtension(pi: ArkExtensionApi) {
	const baseUrl = resolveBaseUrl();
	const warn = (message: string) => pi.logger?.warn(message);

	if (isPiHost(pi)) {
		pi.registerProvider(PROVIDER_ID, {
			name: PROVIDER_NAME,
			baseUrl,
			// pi interpolates `$NAME` from the environment; a bare name would be
			// used as the literal key.
			apiKey: PI_API_KEY_REF,
			api: PI_CHAT_API,
			// An empty list keeps pi from inheriting built-in models for this id;
			// `refreshModels` is the only source.
			models: [],
			refreshModels: context => refreshPiModels(context, { baseUrl, warn }),
			// ARK's image endpoint is not `openrouter-images`, so it needs its own
			// runner; pi dispatches on the model's `api`.
			images: {
				[PI_IMAGE_API]: {
					generateImages: (...args: never[]) =>
						(generateArkImages as unknown as (...a: never[]) => unknown)(...args),
				},
			},
		} satisfies PiProviderConfig);
		return;
	}

	pi.registerProvider(PROVIDER_ID, {
		baseUrl,
		apiKey: CONFIGURED_KEY_FALLBACK,
		api: "openai-completions",
		// omp passes the resolved credential (a key string) or undefined.
		fetchDynamicModels: async credential => {
			const loaded = await loadArkRows({
				baseUrl,
				apiKey: credential ?? "",
				warn,
				allowNetwork: true,
				force: isForcedRefresh(),
			});
			return mapArkModels(loaded.rows).models;
		},
	} satisfies OmpProviderConfig);
}

export { ARK_BASE_URL, ARK_API_KEY_ENV, mapArkModel, mapArkModels, mapApi, mapEffort, mapInput, mapLimits } from "./ark.ts";
export { buildArkImageBody, parseArkImageResponse } from "./pi-images.ts";
