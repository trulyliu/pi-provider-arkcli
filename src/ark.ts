/**
 * Pure mapping from ARK `GET /api/v3/models` rows to omp model rows.
 *
 * No host imports here: every rule is testable against a captured payload
 * (see test/ark.test.ts and test/fixtures/ark-models.sample.json).
 *
 * Field names come from the ARK contract
 * https://console.volcengine.com/ark/region:cn-beijing/docs/models-api
 * and were confirmed against the live endpoint; see docs/ark-models-api.md.
 */

export const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const ARK_API_KEY_ENV = "ARK_API_KEY";

/** omp's effort ladder, ascending. Anything outside it cannot be a level. */
export const OMP_EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OmpEffort = (typeof OMP_EFFORT_LADDER)[number];

/** omp's `input` accepts only these; a `video`/`audio` value fails schema validation. */
export const OMP_INPUT_MODALITIES = ["text", "image"] as const;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;

export type SkipReason =
	| "no-id"
	| "no-chat-api"
	| "unsupported-output"
	| "no-input-modality";

export interface ArkModalities {
	input_modalities?: string[] | null;
	output_modalities?: string[] | null;
}

export interface ArkEffortSpec {
	supported_levels?: string[] | null;
	default_level?: string | null;
}

export interface ArkTokenLimits {
	context_window?: number | null;
	max_input_token_length?: number | null;
	max_output_token_length?: number | null;
	max_reasoning_token_length?: number | null;
}

export interface ArkFeatures {
	thinking?: { type?: string | null; types?: string[] | null } | null;
	tools?: { function_calling?: boolean | null; web_search?: boolean | null } | null;
	structured_outputs?: { json_object?: boolean | null; json_schema?: boolean | null } | null;
	cache?: { prefix_cache?: boolean | null; session_cache?: boolean | null } | null;
	batch?: { batch_job?: boolean | null; batch_chat?: boolean | null } | null;
}

/** One row of ARK's `/api/v3/models` payload. Only the fields we read are typed. */
export interface ArkModelRow {
	id?: string | null;
	name?: string | null;
	version?: string | null;
	domain?: string | null;
	status?: string | null;
	context_window?: number | null;
	max_output_tokens?: number | null;
	token_limits?: ArkTokenLimits | null;
	modalities?: ArkModalities | null;
	effort?: ArkEffortSpec | null;
	features?: ArkFeatures | null;
	api_supported?: Record<string, unknown> | null;
	task_type?: string[] | null;
}

export interface ArkThinking {
	mode: "effort";
	efforts: OmpEffort[];
	defaultLevel?: OmpEffort;
}

export interface ArkCompat {
	maxTokensField: "max_tokens";
	supportsReasoningEffort?: true;
	reasoningDisableMode?: "none-effort";
}

/** The subset of an omp model definition this plugin produces. */
export interface OmpModelRow {
	id: string;
	name: string;
	api: string;
	kind?: "chat" | "image" | "embedding";
	reasoning: boolean;
	thinking?: ArkThinking;
	input: Array<(typeof OMP_INPUT_MODALITIES)[number]>;
	supportsTools?: boolean;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: ArkCompat;
}

export type MapResult = { ok: true; model: OmpModelRow } | { ok: false; reason: SkipReason };

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isOmpEffort(value: string): value is OmpEffort {
	return (OMP_EFFORT_LADDER as readonly string[]).includes(value);
}

/**
 * ARK spells the off-switch as an effort level `none`; omp models "off" as the
 * absence of a level plus `compat.reasoningDisableMode`. `none` therefore never
 * becomes an effort. Without `none-effort` omp falls back to `lowest-effort`,
 * which still requests reasoning, so every reasoning row gets it.
 *
 * ARK accepts unadvertised levels rather than rejecting them: `none` on
 * `glm-5-3-flash-260828` (which advertises only low/high/max) returned 2
 * reasoning tokens, and `xhigh` on the same model was accepted.
 */
export function mapEffort(effort: ArkEffortSpec | null | undefined): ArkThinking | undefined {
	const levels = Array.isArray(effort?.supported_levels) ? effort.supported_levels : [];
	const advertised = levels
		.filter((level): level is string => typeof level === "string")
		.map(level => level.toLowerCase());
	const efforts = [...new Set(advertised.filter(isOmpEffort))].sort(
		(a, b) => OMP_EFFORT_LADDER.indexOf(a) - OMP_EFFORT_LADDER.indexOf(b),
	);
	if (efforts.length === 0) return undefined;

	const declared = typeof effort?.default_level === "string" ? effort.default_level.toLowerCase() : undefined;
	const defaultLevel = declared !== undefined && isOmpEffort(declared) && efforts.includes(declared)
		? declared
		: efforts[0];
	return { mode: "effort", efforts, defaultLevel };
}

/** ARK reports `video`/`audio` too; omp's `input` schema rejects them. */
export function mapInput(modalities: ArkModalities | null | undefined): OmpModelRow["input"] {
	const declared = Array.isArray(modalities?.input_modalities) ? modalities.input_modalities : [];
	const input: OmpModelRow["input"] = [];
	// A chat row always accepts text; ARK omits the array on rows it publishes
	// without modality metadata (`doubao-smart-router-250928`).
	input.push("text");
	if (declared.some(modality => String(modality).toLowerCase() === "image")) input.push("image");
	return input;
}

function singleOutput(modalities: ArkModalities | null | undefined): string | undefined {
	const outputs = Array.isArray(modalities?.output_modalities)
		? modalities.output_modalities.map(output => String(output).toLowerCase())
		: [];
	return outputs.length === 1 ? outputs[0] : undefined;
}

function supports(api: Record<string, unknown> | null | undefined, name: string): boolean {
	return Boolean(api && api[name]);
}

/**
 * Choose the runner API. ARK serves five disjoint surfaces; only chat,
 * image generation and text embedding share an omp transport.
 * Video generation (`contents/generations`) and multimodal embeddings have no
 * omp transport, so those rows are skipped rather than mis-registered.
 */
export function mapApi(row: ArkModelRow): { api: string; kind?: OmpModelRow["kind"] } | undefined {
	const api = row.api_supported;
	const output = singleOutput(row.modalities);
	if (output === "image" && supports(api, "images/generations")) {
		return { api: "openai-images", kind: "image" };
	}
	// ARK omits the whole `modalities` block on text-embedding rows
	// (`doubao-embedding-large-text-250515`), so `output` cannot be the gate here.
	// Multimodal embeddings have no omp transport and are excluded by the api key.
	if (supports(api, "embeddings") && !supports(api, "embeddings/multimodal")) {
		return { api: "openai-embeddings", kind: "embedding" };
	}
	if (supports(api, "chat/completions")) {
		return { api: "openai-completions", kind: "chat" };
	}
	return undefined;
}

/**
 * ARK caps output per model; omp additionally requires the value not exceed the
 * context window. `token_limits.max_output_token_length` and the top-level
 * `max_output_tokens` agree on every live row, so either is authoritative.
 */
export function mapLimits(row: ArkModelRow): { contextWindow: number; maxTokens: number } {
	const limits = row.token_limits ?? undefined;
	const contextWindow =
		positiveInt(limits?.context_window) ?? positiveInt(row.context_window) ?? DEFAULT_CONTEXT_WINDOW;
	const output =
		positiveInt(limits?.max_output_token_length) ?? positiveInt(row.max_output_tokens) ?? DEFAULT_MAX_TOKENS;
	return { contextWindow, maxTokens: Math.min(output, contextWindow) };
}

export function mapArkModel(row: ArkModelRow): MapResult {
	const id = typeof row.id === "string" ? row.id.trim() : "";
	if (!id) return { ok: false, reason: "no-id" };

	const api = mapApi(row);
	if (!api) {
		const output = singleOutput(row.modalities);
		if (output === "video" || supports(row.api_supported, "contents/generations")) {
			return { ok: false, reason: "unsupported-output" };
		}
		if (supports(row.api_supported, "embeddings/multimodal")) return { ok: false, reason: "unsupported-output" };
		if (supports(row.api_supported, "chat/completions")) return { ok: false, reason: "unsupported-output" };
		return { ok: false, reason: "no-chat-api" };
	}

	const input = mapInput(row.modalities);
	if (input.length === 0) return { ok: false, reason: "no-input-modality" };
	const { contextWindow, maxTokens } = mapLimits(row);
	const thinking = mapEffort(row.effort);

	const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : id;
	const version = typeof row.version === "string" ? row.version.trim() : "";

	return {
		ok: true,
		model: {
			id,
			// Versions share a `name`; the version suffix keeps the picker unambiguous.
			name: version && !name.includes(version) ? `${name} (${version})` : name,
			api: api.api,
			...(api.kind ? { kind: api.kind } : {}),
			reasoning: thinking !== undefined,
			...(thinking ? { thinking } : {}),
			input,
			...(typeof row.features?.tools?.function_calling === "boolean"
				? { supportsTools: row.features.tools.function_calling }
				: {}),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			compat: {
				// ARK rejects `max_tokens` and `max_completion_tokens` together.
				maxTokensField: "max_tokens",
				...(thinking
					? { supportsReasoningEffort: true as const, reasoningDisableMode: "none-effort" as const }
					: {}),
			},
		},
	};
}

/** Map a full payload, dropping unusable rows and de-duplicating by id. */
export function mapArkModels(rows: readonly ArkModelRow[]): {
	models: OmpModelRow[];
	skipped: Array<{ id: string; reason: SkipReason }>;
} {
	const byId = new Map<string, OmpModelRow>();
	const skipped: Array<{ id: string; reason: SkipReason }> = [];
	for (const row of rows) {
		const result = mapArkModel(row);
		if (result.ok) byId.set(result.model.id, result.model);
		else skipped.push({ id: typeof row.id === "string" ? row.id : "", reason: result.reason });
	}
	return { models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), skipped };
}
