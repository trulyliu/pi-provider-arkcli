/**
 * `arkcli` provider extension: ARK `GET /api/v3/models` -> omp model rows.
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
 */

import {
	ARK_API_KEY_ENV,
	ARK_BASE_URL,
	type ArkModelRow,
	mapArkModels,
	type OmpModelRow,
} from "./ark.ts";
import { fetchArkModels } from "./discovery.ts";

export const PROVIDER_ID = "arkcli";

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

export interface ArkExtensionApi {
	registerProvider(
		name: string,
		config: {
			baseUrl: string;
			apiKey: string;
			api: string;
			models?: OmpModelRow[];
			fetchDynamicModels?: (apiKey?: string) => Promise<OmpModelRow[]>;
		},
	): void;
	logger?: { debug(...args: unknown[]): void; warn(...args: unknown[]): void };
}

export default function arkcliExtension(pi: ArkExtensionApi) {
	const baseUrl = resolveBaseUrl();
	pi.registerProvider(PROVIDER_ID, {
		baseUrl,
		apiKey: CONFIGURED_KEY_FALLBACK,
		api: "openai-completions",
		// omp passes the resolved credential (a key string) or undefined.
		fetchDynamicModels: async credential => {
			try {
				return await discoverArkModels({ baseUrl, apiKey: credential });
			} catch (error) {
				pi.logger?.warn(
					`${PROVIDER_ID}: model discovery failed; keeping previously discovered models. ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return [];
			}
		},
	});
}

export { ARK_BASE_URL, ARK_API_KEY_ENV, mapArkModel, mapArkModels, mapApi, mapEffort, mapInput, mapLimits } from "./ark.ts";
