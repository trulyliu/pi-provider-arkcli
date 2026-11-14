/**
 * `GET /api/v3/models` client. Returns raw rows; mapping lives in src/ark.ts.
 */

import { ARK_BASE_URL, type ArkModelRow } from "./ark.ts";

/** The provider is registered under `{baseUrl}/chat/completions`, so the model
 * list is the sibling `/models` with no `/v1` injected. */
export const ARK_MODELS_PATH = "/models";

export interface FetchArkModelsOptions {
	baseUrl?: string;
	apiKey: string;
	/** Aborts the request; omp bounds extension discovery to 15 s. */
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}

export class ArkModelsError extends Error {
	readonly status: number | undefined;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "ArkModelsError";
		this.status = status;
	}
}

/**
 * ARK returns the complete visible list in one response (no pagination in the
 * contract). Rows are returned verbatim so callers can inspect them.
 */
export async function fetchArkModels(options: FetchArkModelsOptions): Promise<ArkModelRow[]> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const baseUrl = (options.baseUrl ?? ARK_BASE_URL).replace(/\/+$/, "");
	const response = await doFetch(`${baseUrl}${ARK_MODELS_PATH}`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
			Accept: "application/json",
		},
		...(options.signal ? { signal: options.signal } : {}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new ArkModelsError(
			`ARK model discovery failed: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`,
			response.status,
		);
	}

	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
		throw new ArkModelsError("ARK model discovery returned a payload without a `data` array");
	}
	return payload.data as ArkModelRow[];
}
