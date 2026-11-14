import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { mapArkModel, mapArkModels, mapEffort, mapInput, mapLimits } from "../src/ark.ts";
import type { ArkModelRow } from "../src/ark.ts";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/ark-models.sample.json", import.meta.url), "utf8"),
) as { data: ArkModelRow[] };

function rowById(id: string): ArkModelRow {
	const row = fixture.data.find(candidate => candidate.id === id);
	assert.ok(row, `fixture is missing ${id}`);
	return row;
}

function mapped(id: string) {
	const result = mapArkModel(rowById(id));
	assert.ok(result.ok, `${id} should map`);
	return result.model;
}

describe("limits", () => {
	it("reads ARK's context_window and max_output_tokens instead of falling back to 128K", () => {
		const model = mapped("deepseek-v4-1-flash-261017");
		assert.equal(model.contextWindow, 1_048_576);
		assert.equal(model.maxTokens, 393_216);
	});

	it("clamps output tokens to the context window", () => {
		assert.deepEqual(mapLimits({ context_window: 100, max_output_tokens: 500 }), {
			contextWindow: 100,
			maxTokens: 100,
		});
	});

	it("falls back only when ARK omits both limit blocks", () => {
		assert.deepEqual(mapLimits({}), { contextWindow: 128_000, maxTokens: 32_768 });
		const router = mapped("doubao-smart-router-250928");
		assert.equal(router.contextWindow, 128_000);
	});
});

describe("input modalities", () => {
	it("keeps text and image, drops video and audio", () => {
		const model = mapped("deepseek-v4-1-flash-261017");
		assert.deepEqual(model.input, ["text", "image"]);
		assert.deepEqual(mapInput({ input_modalities: ["text", "video", "audio"] }), ["text"]);
	});

	it("always includes text, because ARK omits the array on some chat rows", () => {
		assert.deepEqual(mapInput(undefined), ["text"]);
		assert.deepEqual(mapInput({ input_modalities: [] }), ["text"]);
	});
});

describe("effort ladder", () => {
	it("drops ARK's `none` level and orders the rest by omp's ladder", () => {
		assert.deepEqual(mapEffort({ supported_levels: ["max", "none", "low", "high"], default_level: "high" }), {
			mode: "effort",
			efforts: ["low", "high", "max"],
			defaultLevel: "high",
		});
	});

	it("keeps `minimal` when the model advertises it", () => {
		assert.deepEqual(mapEffort({ supported_levels: ["low", "medium", "high", "minimal"], default_level: "high" }), {
			mode: "effort",
			efforts: ["minimal", "low", "medium", "high"],
			defaultLevel: "high",
		});
	});

	it("falls back to the lowest advertised level when the default is not dialable", () => {
		const thinking = mapEffort({ supported_levels: ["high", "max"], default_level: "none" });
		assert.equal(thinking?.defaultLevel, "high");
	});

	it("reports no reasoning when ARK advertises no levels", () => {
		assert.equal(mapEffort({}), undefined);
		assert.equal(mapEffort({ supported_levels: [] }), undefined);
		const qwen = mapped("qwen3-14b-20250429");
		assert.equal(qwen.reasoning, false);
		assert.equal(qwen.thinking, undefined);
	});

	it("routes the off switch through reasoning_effort, not a thinking body", () => {
		const model = mapped("deepseek-v4-1-flash-261017");
		assert.equal(model.compat.reasoningDisableMode, "none-effort");
		assert.equal(model.compat.maxTokensField, "max_tokens");
		// `thinking.type: disabled` would also work, but only effort is needed here.
		assert.equal("whenThinking" in model.compat, false);
	});
});

describe("api routing", () => {
	it("sends chat rows to openai-completions", () => {
		const model = mapped("doubao-seed-evolving");
		assert.equal(model.api, "openai-completions");
		assert.equal(model.kind, "chat");
	});

	it("classifies text-embedding rows that omit the whole `modalities` block", () => {
		// doubao-embedding-large-text-250515 has no modalities at all; gating on
		// output_modalities would silently drop every text embedding model.
		const model = mapped("doubao-embedding-large-text-250515");
		assert.equal(model.api, "openai-embeddings");
		assert.equal(model.kind, "embedding");
	});

	it("sends image-generation rows to openai-images", () => {
		const model = mapped("doubao-seedream-5-5-261028");
		assert.equal(model.api, "openai-images");
		assert.equal(model.kind, "image");
	});

	it("skips video, 3D, multimodal-embedding and router rows instead of mis-registering them", () => {
		const { skipped } = mapArkModels(fixture.data);
		const reasons = new Map(skipped.map(entry => [entry.id, entry.reason]));
		assert.equal(reasons.get("doubao-seedance-2-5-260628"), "unsupported-output");
		assert.equal(reasons.get("doubao-seed3d-2-0-260328"), "unsupported-output");
		// Multimodal embeddings advertise `embeddings/multimodal`; omp has no transport.
		assert.equal(reasons.get("doubao-embedding-vision-251215"), "unsupported-output");
		assert.equal(reasons.get("doubao-embedding-vision-250328"), "unsupported-output");
		assert.equal(reasons.has("doubao-seedream-5-5-261028"), false);
	});
});

describe("payload mapping", () => {
	it("maps every chat row and never emits a video/audio input", () => {
		const { models, skipped } = mapArkModels(fixture.data);
		assert.equal(models.length + skipped.length, fixture.data.length);
		for (const model of models) {
			for (const modality of model.input) {
				assert.ok(modality === "text" || modality === "image", `${model.id} leaked ${modality}`);
			}
		}
	});

	it("de-duplicates rows and drops entries without an id", () => {
		const { models, skipped } = mapArkModels([
			{ id: "dup", api_supported: { "chat/completions": true }, context_window: 1000, max_output_tokens: 10 },
			{ id: "dup", api_supported: { "chat/completions": true }, context_window: 2000, max_output_tokens: 20 },
			{ id: "" },
		]);
		assert.equal(models.length, 1);
		assert.equal(models[0].contextWindow, 2000);
		assert.deepEqual(skipped, [{ id: "", reason: "no-id" }]);
	});

	it("appends the version so ids that share a name stay distinct, and never twice", () => {
		assert.equal(mapped("doubao-seed-2-0-pro-260215").name, "doubao-seed-2-0-pro (260215)");
		const result = mapArkModel({
			id: "x-260101",
			name: "already-suffixed (260101)",
			version: "260101",
			api_supported: { "chat/completions": true },
			context_window: 1000,
			max_output_tokens: 10,
		});
		assert.ok(result.ok);
		assert.equal(result.model.name, "already-suffixed (260101)");
	});
});
