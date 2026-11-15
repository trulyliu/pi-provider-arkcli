/**
 * Pure mapping from omp model rows to pi (`@earendil-works/pi-coding-agent`)
 * provider model configs.
 *
 * pi and omp agree on the facts but not the field names: pi spells thinking as
 * `reasoning: boolean` + `thinkingLevelMap`, and it has no embedding model type.
 * Mapping is chained off `mapArkModels` so both hosts read one source of truth.
 *
 * pi's thinking model, from `@earendil-works/pi-ai/dist/models.js`:
 * - `getSupportedThinkingLevels` drops every level mapped to `null`, and only
 *   supports `xhigh`/`max` when the map gives them a value;
 * - an absent requested level is clamped up, then down, then to the first
 *   supported level;
 * - with no requested effort and `reasoning: true`, the value of
 *   `thinkingLevelMap.off` is sent as `reasoning_effort`.
 *
 * So `off: "none"` is how this plugin expresses "no reasoning" to ARK, which
 * accepts `reasoning_effort: "none"` and answers without reasoning content.
 */

import type { OmpEffort, OmpModelRow } from "./ark.ts";
import { OMP_EFFORT_LADDER } from "./ark.ts";

/** pi resolves `$NAME` / `${NAME}` / `!command`; a bare env name is a literal key. */
export const PI_API_KEY_REF = "$ARK_API_KEY";

/** pi's chat runner for OpenAI-compatible endpoints. */
export const PI_CHAT_API = "openai-completions";

/** ARK's image endpoint is not `openrouter-images`; this key selects our runner. */
export const PI_IMAGE_API = "ark-images";

export type PiThinkingLevel = "off" | OmpEffort;

export interface PiModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * ARK rejects `max_tokens` and `max_completion_tokens` together, and pi detects
 * ARK's hostname as "standard OpenAI" — which means `max_completion_tokens`.
 * The override is mandatory, not cosmetic.
 */
export interface PiChatCompat {
	maxTokensField: "max_tokens";
	supportsReasoningEffort?: true;
}

export type PiThinkingLevelMap = Record<PiThinkingLevel, string | null>;

export interface PiChatModelConfig {
	type: "chat";
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: PiModelCost;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: PiThinkingLevelMap;
	compat?: PiChatCompat;
}

export interface PiImageModelConfig {
	type: "image";
	id: string;
	name: string;
	api: string;
	input: Array<"text" | "image">;
	output: ["image"];
	cost: PiModelCost;
}

export type PiModelConfig = PiChatModelConfig | PiImageModelConfig;

/** A config that pi can persist in its model store: provider/api/baseUrl resolved. */
export type PiStoredModel = PiModelConfig & { provider: string; api: string; baseUrl: string };

const ZERO_COST: PiModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * ARK advertises the levels it accepts; everything pi would otherwise assume
 * must be spelled out, because `minimal`/`medium` are pi defaults but ARK
 * models usually advertise only `low`/`high`/`max`.
 */
export function mapThinkingLevelMap(model: OmpModelRow): PiThinkingLevelMap | undefined {
	if (!model.reasoning || !model.thinking) return undefined;
	const advertised = new Set<OmpEffort>(model.thinking.efforts);
	const map = { off: "none" } as PiThinkingLevelMap;
	for (const level of OMP_EFFORT_LADDER) map[level] = advertised.has(level) ? level : null;
	return map;
}

/** One omp row -> one pi config, or `undefined` when pi has no such model type. */
export function mapArkModelToPi(model: OmpModelRow): PiModelConfig | undefined {
	const input = [...model.input];
	if (model.kind === "embedding") return undefined;
	if (model.kind === "image") {
		return {
			type: "image",
			id: model.id,
			name: model.name,
			api: PI_IMAGE_API,
			input,
			output: ["image"],
			cost: { ...ZERO_COST },
		};
	}

	const thinkingLevelMap = mapThinkingLevelMap(model);
	return {
		type: "chat",
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input,
		cost: { ...ZERO_COST },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		compat: {
			maxTokensField: model.compat.maxTokensField,
			...(thinkingLevelMap ? { supportsReasoningEffort: true as const } : {}),
		},
	};
}

/** Maps a whole catalog; rows pi cannot represent are dropped, not mislabelled. */
export function mapArkModelsToPi(rows: readonly OmpModelRow[]): PiModelConfig[] {
	const models: PiModelConfig[] = [];
	for (const row of rows) {
		const mapped = mapArkModelToPi(row);
		if (mapped) models.push(mapped);
	}
	return models;
}

/** Fills the fields pi resolves per model before persisting it in its model store. */
export function completePiModel(model: PiModelConfig, provider: string, baseUrl: string): PiStoredModel {
	return {
		...model,
		provider,
		api: model.type === "image" ? PI_IMAGE_API : PI_CHAT_API,
		baseUrl,
	};
}

/** Stored models arrive already composed; keep only this provider's rows of a known type. */
export function restorePiModels(
	stored: readonly unknown[] | undefined,
	provider: string,
): PiStoredModel[] {
	const restored: PiStoredModel[] = [];
	for (const entry of stored ?? []) {
		if (!entry || typeof entry !== "object") continue;
		const model = entry as Record<string, unknown>;
		if (model.provider !== provider) continue;
		if (model.type !== "chat" && model.type !== "image") continue;
		restored.push(entry as PiStoredModel);
	}
	return restored;
}
