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
 * When discovery is unreachable or the account has no key, registering no rows
 * is safe: omp keeps the provider unselectable rather than inventing models.
 * A thrown error would surface as a discovery failure for the whole provider.
 */
export async function discoverArkModels(options: {
	baseUrl?: string;
	apiKey?: string;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}): Promise<OmpModelRow[]> {
	if (!options.apiKey) return [];
	const rows: ArkModelRow[] = await fetchArkModels({
		baseUrl: options.baseUrl,
		apiKey: options.apiKey,
		signal: options.signal,
		fetch: options.fetch,
	});
	return mapArkModels(rows).models;
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
 */
async function refreshPiModels(
	context: PiRefreshContext,
	deps: { baseUrl: string; warn(message: string): void },
): Promise<PiModelConfig[]> {
	const stored = restorePiModels(context.stored?.models, PROVIDER_ID);
	if (!context.allowNetwork) return stored;
	if (context.signal.aborted) return stored;

	const apiKey =
		context.credential?.type === "api_key" ? context.credential.key : process.env[ARK_API_KEY_ENV];
	if (!apiKey) return stored;

	try {
		const rows = await discoverArkModels({ baseUrl: deps.baseUrl, apiKey, signal: context.signal });
		const models = mapArkModelsToPi(rows);
		const persisted: PiStoredModel[] = models.map(model =>
			completePiModel(model, PROVIDER_ID, deps.baseUrl),
		);
		await context.publish({ persist: { models: persisted, checkedAt: Date.now() } });
		return models;
	} catch (error) {
		// Throwing would surface as a model-refresh error for the whole provider.
		deps.warn(
			`${PROVIDER_ID}: model discovery failed; keeping the previously discovered models. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return stored;
	}
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
			try {
				return await discoverArkModels({ baseUrl, apiKey: credential });
			} catch (error) {
				warn(
					`${PROVIDER_ID}: model discovery failed; keeping previously discovered models. ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return [];
			}
		},
	} satisfies OmpProviderConfig);
}

export { ARK_BASE_URL, ARK_API_KEY_ENV, mapArkModel, mapArkModels, mapApi, mapEffort, mapInput, mapLimits } from "./ark.ts";
export { buildArkImageBody, parseArkImageResponse } from "./pi-images.ts";
