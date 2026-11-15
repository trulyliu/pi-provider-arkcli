import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { mapArkModels, type ArkModelRow, type OmpModelRow } from "../src/ark.ts";
import arkcliExtension from "../src/index.ts";
import {
	buildArkImageBody,
	parseArkImageResponse,
	generateArkImages,
} from "../src/pi-images.ts";
import {
	completePiModel,
	PI_API_KEY_REF,
	mapArkModelsToPi,
	mapArkModelToPi,
	mapThinkingLevelMap,
	restorePiModels,
	type PiChatModelConfig,
	type PiImageModelConfig,
} from "../src/pi.ts";

const payload = JSON.parse(
	readFileSync(new URL("./fixtures/ark-models.sample.json", import.meta.url), "utf8"),
) as { data: ArkModelRow[] };

const ompRows = mapArkModels(payload.data).models;

function ompRow(id: string): OmpModelRow {
	const row = ompRows.find(candidate => candidate.id === id);
	assert.ok(row, `fixture is missing ${id}`);
	return row;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("pi model mapping", () => {
	it("keeps the chat ladder ARK advertises and closes the gaps with null", () => {
		const map = mapThinkingLevelMap(ompRow("deepseek-v4-1-flash-261017"));
		assert.deepEqual(map, {
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("maps `off` to ARK's none effort, which is what turns reasoning off", () => {
		// pi sends thinkingLevelMap.off as reasoning_effort when no level is requested.
		assert.equal(mapThinkingLevelMap(ompRow("deepseek-v4-1-flash-261017"))?.off, "none");
	});

	it("advertises xhigh only when ARK does", () => {
		const withXhigh = mapThinkingLevelMap({
			...ompRow("deepseek-v4-1-flash-261017"),
			thinking: { mode: "effort", efforts: ["low", "xhigh"], defaultLevel: "low" },
		});
		assert.equal(withXhigh?.xhigh, "xhigh");
		const withoutXhigh = mapThinkingLevelMap(ompRow("deepseek-v4-1-flash-261017"));
		assert.equal(withoutXhigh?.xhigh, null);
	});

	it("omits the level map for models without a thinking ladder", () => {
		const model = mapArkModelToPi(ompRow("glm-4-5-air-20250728"));
		assert.ok(model && model.type === "chat");
		assert.equal(model.reasoning, false);
		assert.equal(model.thinkingLevelMap, undefined);
		assert.equal(model.compat?.supportsReasoningEffort, undefined);
	});

	it("forces max_tokens, because ARK 400s when both token fields are sent", () => {
		for (const model of mapArkModelsToPi(ompRows)) {
			if (model.type !== "chat") continue;
			assert.equal(model.compat?.maxTokensField, "max_tokens", `${model.id} must pin max_tokens`);
		}
	});

	it("carries discovery limits onto the pi row", () => {
		const model = mapArkModelToPi(ompRow("deepseek-v4-1-flash-261017"));
		assert.ok(model && model.type === "chat");
		assert.equal(model.contextWindow, 1_048_576);
		assert.equal(model.maxTokens, 393_216);
		assert.deepEqual(model.input, ["text", "image"]);
	});

	it("drops embedding rows, which pi has no model type for", () => {
		const embeddings = ompRows.filter(row => row.kind === "embedding");
		assert.ok(embeddings.length > 0, "fixture must contain embeddings for this to mean anything");
		const piIds = new Set(mapArkModelsToPi(ompRows).map(model => model.id));
		for (const row of embeddings) assert.equal(piIds.has(row.id), false, `${row.id} must be dropped`);
	});

	it("maps image rows onto its own api key so the built-in runner is not reused", () => {
		const images = ompRows.filter(row => row.kind === "image");
		assert.ok(images.length > 0);
		for (const row of images) {
			const model = mapArkModelToPi(row);
			assert.ok(model && model.type === "image");
			assert.equal(model.api, "ark-images");
			assert.deepEqual(model.output, ["image"]);
		}
		const sample = mapArkModelToPi(images[0]) as PiImageModelConfig;
		assert.deepEqual(sample.input, ["text", "image"]);
	});

	it("keeps chat and image rows and drops nothing else silently", () => {
		const mapped = mapArkModelsToPi(ompRows);
		assert.equal(mapped.length, ompRows.filter(row => row.kind !== "embedding").length);
		assert.equal(mapped.filter(model => model.type === "chat").length, 27);
		assert.equal(mapped.filter(model => model.type === "image").length, 5);
	});

	it("stamps provider, api and baseUrl when preparing a persisted row", () => {
		const model = mapArkModelToPi(ompRow("deepseek-v4-1-flash-261017")) as PiChatModelConfig;
		const stored = completePiModel(model, "arkcli", "https://example.test/api/v3");
		assert.equal(stored.provider, "arkcli");
		assert.equal(stored.api, "openai-completions");
		assert.equal(stored.baseUrl, "https://example.test/api/v3");
	});

	it("restores only this provider's chat and image rows", () => {
		const stored = [
			{ type: "chat", id: "a", provider: "arkcli" },
			{ type: "image", id: "b", provider: "arkcli" },
			{ type: "chat", id: "c", provider: "openai" },
			{ type: "classifier", id: "d", provider: "arkcli" },
			{ nope: true },
		];
		assert.deepEqual(
			restorePiModels(stored, "arkcli").map(model => model.id),
			["a", "b"],
		);
	});
});

describe("pi provider registration", () => {
	const originalBaseUrl = process.env.ARK_BASE_URL;
	const originalFetch = globalThis.fetch;
	const originalKey = process.env.ARK_API_KEY;

	afterEach(() => {
		if (originalBaseUrl === undefined) delete process.env.ARK_BASE_URL;
		else process.env.ARK_BASE_URL = originalBaseUrl;
		if (originalKey === undefined) delete process.env.ARK_API_KEY;
		else process.env.ARK_API_KEY = originalKey;
		globalThis.fetch = originalFetch;
	});

	interface PiConfig {
		name?: string;
		baseUrl: string;
		apiKey: string;
		api: string;
		models?: unknown[];
		refreshModels?: (context: {
			credential?: { type: string; key?: string };
			stored?: { models?: readonly unknown[] };
			allowNetwork: boolean;
			signal: AbortSignal;
			publish(publication: { persist?: unknown }): Promise<boolean>;
		}) => Promise<unknown[]>;
		images?: Record<string, unknown>;
	}

	function registerPi(): { name: string; config: PiConfig; published: unknown[] } {
		let registered: { name: string; config: PiConfig } | undefined;
		const published: unknown[] = [];
		arkcliExtension({
			registerProvider: (name, config) => {
				registered = { name, config: config as PiConfig };
			},
			// The presence of this method is what selects the pi branch.
			registerVirtualModel: () => {},
		});
		assert.ok(registered, "extension must register a provider");
		return { ...registered, published };
	}

	function context(overrides: Partial<Parameters<NonNullable<PiConfig["refreshModels"]>>[0]> = {}) {
		return {
			credential: { type: "api_key", key: "ark-test" },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => true,
			...overrides,
		};
	}

	it("detects pi and registers the pi contract", () => {
		const { name, config } = registerPi();
		assert.equal(name, "arkcli");
		assert.equal(config.api, "openai-completions");
		assert.deepEqual(config.models, []);
	});

	it("references the key with pi's env syntax, not a bare name", () => {
		const { config } = registerPi();
		assert.equal(config.apiKey, "$ARK_API_KEY");
		assert.equal(config.apiKey, PI_API_KEY_REF);
	});

	it("registers an image runner under the model api", () => {
		const { config } = registerPi();
		assert.deepEqual(Object.keys(config.images ?? {}), ["ark-images"]);
		assert.equal(typeof (config.images?.["ark-images"] as { generateImages: unknown }).generateImages, "function");
	});

	it("returns mapped rows from refreshModels", async () => {
		globalThis.fetch = (async () => jsonResponse({ data: payload.data })) as typeof globalThis.fetch;
		const { config } = registerPi();
		const models = (await config.refreshModels?.(context())) as PiChatModelConfig[];
		assert.equal(models.filter(model => model.type === "chat").length, 27);
	});

	it("publishes a persisted catalog so a later offline session can restore it", async () => {
		globalThis.fetch = (async () => jsonResponse({ data: payload.data })) as typeof globalThis.fetch;
		const { config } = registerPi();
		let persisted: unknown;
		await config.refreshModels?.(
			context({
				publish: async publication => {
					persisted = publication.persist;
					return true;
				},
			}),
		);
		const models = (persisted as { models: Array<Record<string, unknown>> }).models;
		assert.equal(models.length, 32);
		for (const model of models) {
			assert.equal(model.provider, "arkcli");
			assert.equal(model.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
		}
	});

	it("serves the stored catalog without the network when pi asks offline", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return jsonResponse({ data: payload.data });
		}) as typeof globalThis.fetch;
		const stored = mapArkModelsToPi(ompRows).map(model => completePiModel(model, "arkcli", "https://x/api/v3"));
		const { config } = registerPi();
		const models = await config.refreshModels?.(
			context({ allowNetwork: false, stored: { models: stored }, credential: undefined }),
		);
		assert.equal(models?.length, 32);
		assert.equal(calls, 0);
	});

	it("falls back to ARK_API_KEY when pi supplies no credential", async () => {
		process.env.ARK_API_KEY = "from-env";
		let authorization: string | null = null;
		globalThis.fetch = (async (_input, init) => {
			authorization = new Headers(init?.headers).get("authorization");
			return jsonResponse({ data: payload.data });
		}) as typeof globalThis.fetch;
		const { config } = registerPi();
		await config.refreshModels?.(context({ credential: undefined }));
		assert.equal(authorization, "Bearer from-env");
	});

	it("returns the stored rows instead of throwing when discovery fails", async () => {
		globalThis.fetch = (async () => {
			throw new Error("proxy unreachable");
		}) as typeof globalThis.fetch;
		const stored = mapArkModelsToPi(ompRows).map(model => completePiModel(model, "arkcli", "https://x/api/v3"));
		const { config } = registerPi();
		const models = await config.refreshModels?.(context({ stored: { models: stored } }));
		assert.equal(models?.length, 32);
	});

	it("does not fetch without any key", async () => {
		delete process.env.ARK_API_KEY;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return jsonResponse({ data: payload.data });
		}) as typeof globalThis.fetch;
		const { config } = registerPi();
		assert.deepEqual(await config.refreshModels?.(context({ credential: undefined })), []);
		assert.equal(calls, 0);
	});

	it("still registers the omp contract when the host is omp", () => {
		let registered: { name: string; config: Record<string, unknown> } | undefined;
		arkcliExtension({
			registerProvider: (name, config) => {
				registered = { name, config: config as Record<string, unknown> };
			},
			logger: { debug: () => {}, warn: () => {} },
		});
		assert.ok(registered);
		assert.equal(registered.config.apiKey, "ARK_API_KEY");
		assert.equal(typeof registered.config.fetchDynamicModels, "function");
		assert.equal(registered.config.refreshModels, undefined);
	});
});

describe("ARK image generation for pi", () => {
	it("sends a base64 response format so the result need not be re-fetched", () => {
		const { body, ok } = buildArkImageBody("doubao-seedream-5-0-260128", [{ type: "text", text: "a red cube" }]);
		assert.equal(ok, true);
		assert.equal(body.model, "doubao-seedream-5-0-260128");
		assert.equal(body.prompt, "a red cube");
		assert.equal(body.response_format, "b64_json");
		assert.equal("image" in body, false);
	});

	it("passes reference images as data urls with a lowercase format", () => {
		const { body } = buildArkImageBody("m", [
			{ type: "text", text: "restyle" },
			{ type: "image", data: "AAA", mimeType: "image/PNG" },
		]);
		assert.deepEqual(body.image, ["data:image/png;base64,AAA"]);
	});

	it("refuses a promptless request instead of sending an empty string", () => {
		const { ok } = buildArkImageBody("m", [{ type: "image", data: "AAA", mimeType: "image/png" }]);
		assert.equal(ok, false);
	});

	it("turns b64_json entries into pi image blocks", () => {
		const result = parseArkImageResponse(
			{ data: [{ b64_json: "QUJD", output_format: "png" }] },
			{ api: "ark-images", provider: "arkcli", model: "m" },
		);
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.output, [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
	});

	it("reports a per-image failure instead of returning an empty success", () => {
		const result = parseArkImageResponse(
			{ data: [{ error: { message: "content policy" } }] },
			{ api: "ark-images", provider: "arkcli", model: "m" },
		);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /content policy/);
	});

	it("surfaces ARK's error message from a non-2xx response", async () => {
		const result = await generateArkImages(
			{ id: "m", api: "ark-images", provider: "arkcli", baseUrl: "https://example.test/api/v3" },
			{ input: [{ type: "text", text: "x" }] },
			{
				apiKey: "k",
				fetch: (async () =>
					jsonResponse({ error: { code: "ModelNotOpen", message: "not activated" } }, 404)) as typeof globalThis.fetch,
			},
		);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /not activated/);
	});

	it("posts to the api-versioned images path", async () => {
		let url = "";
		await generateArkImages(
			{ id: "m", api: "ark-images", provider: "arkcli", baseUrl: "https://example.test/api/v3/" },
			{ input: [{ type: "text", text: "x" }] },
			{
				apiKey: "k",
				fetch: (async (input: string | URL | Request) => {
					url = String(input);
					return jsonResponse({ data: [{ b64_json: "QUJD" }] });
				}) as typeof globalThis.fetch,
			},
		);
		assert.equal(url, "https://example.test/api/v3/images/generations");
	});
});
