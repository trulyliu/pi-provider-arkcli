import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import type { ArkModelRow } from "../src/ark.ts";
import {
	MODEL_CACHE_VERSION,
	modelCacheDir,
	modelCacheFile,
	readModelCache,
	writeModelCache,
} from "../src/cache.ts";
import arkcliExtension, { cacheTtlMs, CACHE_TTL_MS, isInteractiveSession, NEGATIVE_TTL_MS } from "../src/index.ts";
import type { OmpModelRow } from "../src/ark.ts";

const payload = JSON.parse(
	readFileSync(new URL("./fixtures/ark-models.sample.json", import.meta.url), "utf8"),
) as { data: ArkModelRow[] };

const dirs: string[] = [];
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "arkcli-cache-test-"));
	dirs.push(dir);
	process.env.ARKCLI_CACHE_DIR = dir;
});
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function cacheDir(): string {
	return dirs[dirs.length - 1]!;
}

describe("model cache", () => {
	it("honours ARKCLI_CACHE_DIR, so tests and throwaway runs never touch the user's cache", () => {
		const previous = process.env.ARKCLI_CACHE_DIR;
		process.env.ARKCLI_CACHE_DIR = "/tmp/arkcli-explicit";
		try {
			assert.equal(modelCacheDir(), "/tmp/arkcli-explicit");
		} finally {
			if (previous === undefined) delete process.env.ARKCLI_CACHE_DIR;
			else process.env.ARKCLI_CACHE_DIR = previous;
		}
	});

	it("keys the file by endpoint and key, so two accounts cannot read each other's catalog", () => {
		const dir = cacheDir();
		const a = modelCacheFile("https://ark.test/api/v3", "ark-key-a", dir);
		const b = modelCacheFile("https://ark.test/api/v3", "ark-key-b", dir);
		const c = modelCacheFile("https://other.test/api/v3", "ark-key-a", dir);
		assert.notEqual(a, b);
		assert.notEqual(a, c);
		assert.equal(a, modelCacheFile("https://ark.test/api/v3", "ark-key-a", dir));
	});

	it("never puts the key in the filename", () => {
		const file = modelCacheFile("https://ark.test/api/v3", "ark-super-secret", cacheDir());
		assert.equal(file.includes("super-secret"), false);
	});

	it("round-trips raw ARK rows so a mapping change applies to an existing cache", async () => {
		const dir = cacheDir();
		const file = modelCacheFile("https://ark.test/api/v3", "k", dir);
		assert.equal(await writeModelCache(file, { baseUrl: "https://ark.test/api/v3", checkedAt: 1234, rows: payload.data }), true);
		const entry = await readModelCache(file);
		assert.ok(entry);
		assert.equal(entry.version, MODEL_CACHE_VERSION);
		assert.equal(entry.checkedAt, 1234);
		assert.equal(entry.rows.length, payload.data.length);
		assert.deepEqual(entry.rows[0], payload.data[0]);
	});

	it("treats a missing file as a miss", async () => {
		assert.equal(await readModelCache(join(cacheDir(), "absent.json")), undefined);
	});

	it("treats corrupt JSON as a miss instead of throwing", async () => {
		const file = join(cacheDir(), "corrupt.json");
		writeFileSync(file, "{not json");
		assert.equal(await readModelCache(file), undefined);
	});

	it("ignores an entry written by an older version", async () => {
		const file = join(cacheDir(), "old.json");
		writeFileSync(
			file,
			JSON.stringify({ version: MODEL_CACHE_VERSION - 1, baseUrl: "x", checkedAt: 1, rows: payload.data }),
		);
		assert.equal(await readModelCache(file), undefined);
	});

	it("drops rows that are not objects with an id", async () => {
		const file = join(cacheDir(), "partial.json");
		writeFileSync(
			file,
			JSON.stringify({
				version: MODEL_CACHE_VERSION,
				baseUrl: "x",
				checkedAt: 1,
				rows: [payload.data[0], null, "nope", { noId: true }, { id: "ok" }],
			}),
		);
		const entry = await readModelCache(file);
		assert.deepEqual(entry?.rows.map(row => row.id), [payload.data[0]!.id, "ok"]);
	});

	it("reports a write failure instead of throwing when the directory is not writable", async () => {
		const file = join(cacheDir(), "file-as-dir", "x.json");
		writeFileSync(join(cacheDir(), "file-as-dir"), "not a directory");
		assert.equal(await writeModelCache(file, { baseUrl: "x", checkedAt: 1, rows: [] }), false);
	});
});

describe("cache ttl", () => {
	it("defaults to six hours", () => {
		assert.equal(cacheTtlMs({}), CACHE_TTL_MS);
	});

	it("honours ARKCLI_CACHE_TTL_MS, including zero", () => {
		assert.equal(cacheTtlMs({ ARKCLI_CACHE_TTL_MS: "0" }), 0);
		assert.equal(cacheTtlMs({ ARKCLI_CACHE_TTL_MS: "60000" }), 60_000);
	});

	it("ignores a value that is not a non-negative number", () => {
		assert.equal(cacheTtlMs({ ARKCLI_CACHE_TTL_MS: "soon" }), CACHE_TTL_MS);
		assert.equal(cacheTtlMs({ ARKCLI_CACHE_TTL_MS: "-1" }), CACHE_TTL_MS);
	});
});

describe("interactive session detection", () => {
	it("treats a piped invocation as one-shot even without a flag", () => {
		assert.equal(isInteractiveSession(["/bin/node", "/bin/pi"], false), false);
	});

	it("treats a subcommand as one-shot even on a terminal", () => {
		assert.equal(isInteractiveSession(["/usr/bin/bun", "/…/omp-linux-x64", "models", "--json"], true), false);
		assert.equal(isInteractiveSession(["/usr/bin/bun", "/…/omp-linux-x64", "doctor"], true), false);
	});

	it("treats every one-shot flag as one-shot", () => {
		for (const argument of ["-p", "--print", "--list-models", "-v", "--version", "-h", "--help"]) {
			assert.equal(isInteractiveSession(["/bin/node", "/bin/omp", argument], true), false, argument);
		}
	});

	it("treats --mode=json/text as one-shot but leaves the rpc modes up", () => {
		assert.equal(isInteractiveSession(["/usr/bin/bun", "/…/omp-linux-x64", "--mode=json", "hi"], true), false);
		assert.equal(isInteractiveSession(["/usr/bin/bun", "/…/omp-linux-x64", "--mode=text", "hi"], true), false);
		assert.equal(isInteractiveSession(["/usr/bin/bun", "/…/omp-linux-x64", "--mode=rpc"], true), true);
	});

	it("treats a TTY session whose first argument is a flag as interactive", () => {
		assert.equal(isInteractiveSession(["/usr/bin/bun", "/…/omp-linux-x64", "-e", "/x/index.ts"], true), true);
		assert.equal(isInteractiveSession(["/bin/node", "/bin/pi", "-e", "/x/index.ts"], true), true);
	});
});

describe("cache-first discovery", () => {
	const originalBaseUrl = process.env.ARK_BASE_URL;
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		if (originalBaseUrl === undefined) delete process.env.ARK_BASE_URL;
		else process.env.ARK_BASE_URL = originalBaseUrl;
		globalThis.fetch = originalFetch;
	});

	function register(baseUrl = "https://ark.test/api/v3"): {
		fetchDynamicModels: (credential?: string) => Promise<OmpModelRow[]>;
		warnings: string[];
	} {
		process.env.ARK_BASE_URL = baseUrl;
		let config: { fetchDynamicModels?: (credential?: string) => Promise<OmpModelRow[]> } | undefined;
		const warnings: string[] = [];
		arkcliExtension({
			registerProvider: (_name, provider) => {
				config = provider as typeof config;
			},
			logger: { debug: () => {}, warn: (message: string) => warnings.push(message) },
		});
		assert.ok(config?.fetchDynamicModels, "omp branch must expose fetchDynamicModels");
		return { fetchDynamicModels: config.fetchDynamicModels, warnings };
	}

	function countingFetch(): { calls: () => number } {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ data: payload.data }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;
		return { calls: () => calls };
	}

	it("waits for ARK on the very first discovery, then serves the same rows from disk", async () => {
		const counter = countingFetch();
		const first = register();
		const firstRows = await first.fetchDynamicModels("ark-key");
		assert.equal(counter.calls(), 1);
		assert.equal(firstRows.length > 0, true);

		const second = register();
		const secondRows = await second.fetchDynamicModels("ark-key");
		assert.equal(counter.calls(), 1, "a warm cache must not call ARK again");
		assert.deepEqual(secondRows, firstRows);
	});

	it("does not start a refresh behind a one-shot invocation", async () => {
		const counter = countingFetch();
		const { fetchDynamicModels } = register();
		await fetchDynamicModels("ark-key");
		assert.equal(counter.calls(), 1);

		// Age the entry past the TTL, then ask again. node --test is not a TTY, so
		// this is a one-shot session and must not touch the network.
		const file = modelCacheFile("https://ark.test/api/v3", "ark-key", process.env.ARKCLI_CACHE_DIR!);
		const entry = await readModelCache(file);
		assert.ok(entry);
		await writeModelCache(file, { baseUrl: entry.baseUrl, checkedAt: 0, rows: entry.rows });

		const again = register();
		await again.fetchDynamicModels("ark-key");
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(counter.calls(), 1, "a one-shot session must leave the cache alone");
	});

	it("keeps the previous cache when the background refresh fails", async () => {
		const counter = countingFetch();
		const { fetchDynamicModels } = register();
		const rows = await fetchDynamicModels("ark-key");
		assert.equal(counter.calls(), 1);

		globalThis.fetch = (async () => {
			throw new Error("proxy unreachable");
		}) as typeof globalThis.fetch;

		const again = register();
		const cached = await again.fetchDynamicModels("ark-key");
		assert.deepEqual(cached, rows);
	});

	it("does not make the next start wait again after a failed attempt", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			throw new Error("proxy unreachable");
		}) as typeof globalThis.fetch;

		const first = register();
		assert.deepEqual(await first.fetchDynamicModels("ark-key"), []);
		assert.equal(calls, 1);

		const second = register();
		assert.deepEqual(await second.fetchDynamicModels("ark-key"), []);
		assert.equal(calls, 1, "a recent failure must not be retried on the next start");
	});

	it("retries once the failure marker ages out", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			throw new Error("proxy unreachable");
		}) as typeof globalThis.fetch;
		const first = register();
		await first.fetchDynamicModels("ark-key");

		const dir = process.env.ARKCLI_CACHE_DIR!;
		const file = modelCacheFile("https://ark.test/api/v3", "ark-key", dir);
		const entry = await readModelCache(file);
		assert.ok(entry);
		await writeModelCache(file, { ...entry, failedAt: Date.now() - NEGATIVE_TTL_MS - 1 });

		const second = register();
		await second.fetchDynamicModels("ark-key");
		assert.equal(calls, 2);
	});

	it("treats an empty cached catalog as a miss", async () => {
		const dir = process.env.ARKCLI_CACHE_DIR!;
		await writeModelCache(modelCacheFile("https://ark.test/api/v3", "ark-key", dir), {
			baseUrl: "https://ark.test/api/v3",
			checkedAt: Date.now(),
			rows: [],
		});
		const counter = countingFetch();
		const { fetchDynamicModels } = register();
		const rows = await fetchDynamicModels("ark-key");
		assert.equal(counter.calls(), 1, "an empty cache must not pin an empty catalog");
		assert.equal(rows.length > 0, true);
	});

	it("separates catalogs by key", async () => {
		const counter = countingFetch();
		const { fetchDynamicModels } = register();
		await fetchDynamicModels("key-a");
		await fetchDynamicModels("key-b");
		assert.equal(counter.calls(), 2);
		await fetchDynamicModels("key-a");
		assert.equal(counter.calls(), 2);
	});
});
