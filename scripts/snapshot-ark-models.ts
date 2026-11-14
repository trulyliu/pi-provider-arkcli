/**
 * Refresh test/fixtures/ark-models.sample.json from the live ARK endpoint.
 *
 * Run this before touching src/ark.ts when ARK changes a field, then check the
 * diff: a new `modalities.input_modalities` value, a new `api_supported` key, or
 * a new `effort.supported_levels` value means the mapper needs a decision.
 */

import { writeFileSync } from "node:fs";

import { ARK_BASE_URL } from "../src/ark.ts";

const apiKey = process.env.ARK_API_KEY;
if (!apiKey) {
	console.error("ARK_API_KEY is not set");
	process.exit(1);
}

const baseUrl = (process.env.ARK_BASE_URL ?? ARK_BASE_URL).replace(/\/+$/, "");

/**
 * Node only honours `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set, which a
 * script cannot do for itself. Behind a proxy, run:
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/snapshot-ark-models.ts
 * omp's own runtime does not need this; Bun connects directly.
 */
const response = await fetch(`${baseUrl}/models`, {
	headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
});
if (!response.ok) {
	console.error(`GET ${baseUrl}/models -> HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
	process.exit(1);
}

const payload = (await response.json()) as { data?: unknown };
if (!Array.isArray(payload.data)) {
	console.error("payload has no `data` array");
	process.exit(1);
}

const target = new URL("../test/fixtures/ark-models.sample.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(payload, null, "\t")}\n`);
console.log(`wrote ${payload.data.length} rows to ${target.pathname}`);
