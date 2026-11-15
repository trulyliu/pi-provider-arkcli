import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { ArkModelsError, fetchArkModels } from "../src/discovery.ts";
import arkcliExtension from "../src/index.ts";
import type { ArkModelRow, OmpModelRow } from "../src/ark.ts";

const payload = JSON.parse(
	readFileSync(new URL("./fixtures/ark-models.sample.json", import.meta.url), "utf8"),
) as { data: ArkModelRow[] };

// Never touch the user's cache, and never let one test's catalog answer the
// next: each test gets an empty cache directory.
const cacheDirs: string[] = [];
function freshCacheDir(): void {
	const dir = mkdtempSync(join(tmpdir(), "arkcli-test-"));
	cacheDirs.push(dir);
	process.env.ARKCLI_CACHE_DIR = dir;
}
beforeEach(freshCacheDir);
after(() => {
	for (const dir of cacheDirs) rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fetchArkModels", () => {
	it("calls /models under the configured base url without injecting /v1", async () => {
		const seen: string[] = [];
		const rows = await fetchArkModels({
			baseUrl: "https://example.test/api/v3///",
			apiKey: "ark-test",
			fetch: async input => {
				seen.push(String(input));
				return jsonResponse({ data: payload.data });
			},
		});
		assert.deepEqual(seen, ["https://example.test/api/v3/models"]);
		assert.equal(rows.length, payload.data.length);
	});

	it("sends the key as a bearer token", async () => {
		let authorization: string | null = null;
		await fetchArkModels({
			baseUrl: "https://example.test/api/v3",
			apiKey: "ark-secret",
			fetch: async (_input, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return jsonResponse({ data: [] });
			},
		});
		assert.equal(authorization, "Bearer ark-secret");
	});

	it("throws a status-carrying error so the caller can log it", async () => {
		await assert.rejects(
			fetchArkModels({
				baseUrl: "https://example.test/api/v3",
				apiKey: "ark-test",
				fetch: async () => jsonResponse({ error: { code: "AuthenticationError" } }, 401),
			}),
			(error: unknown) => error instanceof ArkModelsError && error.status === 401,
		);
	});

	it("rejects a payload that is not ARK's list shape", async () => {
		await assert.rejects(
			fetchArkModels({
				baseUrl: "https://example.test/api/v3",
				apiKey: "ark-test",
				fetch: async () => jsonResponse({ models: [] }),
			}),
			/payload without a `data` array/,
		);
	});
});

describe("extension registration", () => {
	const originalBaseUrl = process.env.ARK_BASE_URL;
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		if (originalBaseUrl === undefined) delete process.env.ARK_BASE_URL;
		else process.env.ARK_BASE_URL = originalBaseUrl;
		globalThis.fetch = originalFetch;
	});

	interface Registered {
		baseUrl: string;
		apiKey: string;
		api: string;
		fetchDynamicModels?: (credential?: string) => Promise<OmpModelRow[]>;
	}

	function register(): { name: string; config: Registered; warnings: string[] } {
		let registered: { name: string; config: Registered } | undefined;
		const warnings: string[] = [];
		arkcliExtension({
			registerProvider: (name, config) => {
				registered = { name, config };
			},
			logger: { debug: () => {}, warn: (message: string) => warnings.push(message) },
		});
		assert.ok(registered, "extension must register a provider");
		return { ...registered, warnings };
	}

	it("registers `arkcli` on openai-completions with an env-backed key", () => {
		const { name, config } = register();
		assert.equal(name, "arkcli");
		assert.equal(config.api, "openai-completions");
		assert.equal(config.apiKey, "ARK_API_KEY");
	});

	it("honours ARK_BASE_URL for both requests and discovery", async () => {
		process.env.ARK_BASE_URL = "http://127.0.0.1:19999/api/v3/";
		const seen: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			seen.push(String(input));
			return jsonResponse({ data: payload.data });
		}) as typeof globalThis.fetch;

		const { config } = register();
		assert.equal(config.baseUrl, "http://127.0.0.1:19999/api/v3");
		const models = await config.fetchDynamicModels?.("ark-test");
		assert.deepEqual(seen, ["http://127.0.0.1:19999/api/v3/models"]);
		assert.ok(models && models.length > 0);
	});

	it("returns no models instead of throwing when discovery fails", async () => {
		globalThis.fetch = (async () => {
			throw new Error("proxy unreachable");
		}) as typeof globalThis.fetch;

		const { config, warnings } = register();
		assert.deepEqual(await config.fetchDynamicModels?.("ark-test"), []);
		assert.match(warnings.join("\n"), /model discovery failed; registering no models for this session/);
	});

	it("registers nothing selectable without a key", async () => {
		globalThis.fetch = (async () => jsonResponse({ data: payload.data })) as typeof globalThis.fetch;
		const { config } = register();
		assert.deepEqual(await config.fetchDynamicModels?.(undefined), []);
	});
});
