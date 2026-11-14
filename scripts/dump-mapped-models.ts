/**
 * Print the mapped rows for the captured fixture, so a mapping change can be
 * reviewed as a table instead of by reading JSON.
 *
 * `node scripts/dump-mapped-models.ts [path-to-payload.json]`
 */

import { readFileSync } from "node:fs";

import { mapArkModels } from "../src/ark.ts";
import type { ArkModelRow } from "../src/ark.ts";

const path = process.argv[2] ?? new URL("../test/fixtures/ark-models.sample.json", import.meta.url).pathname;
const payload = JSON.parse(readFileSync(path, "utf8")) as { data: ArkModelRow[] };
const { models, skipped } = mapArkModels(payload.data);

console.log("id\tapi\tkind\tinput\tefforts\tdefault\tcontext\tmaxTokens\tdisableMode");
for (const model of models) {
	console.log(
		[
			model.id,
			model.api,
			model.kind ?? "-",
			model.input.join("+"),
			model.thinking?.efforts.join(",") ?? "-",
			model.thinking?.defaultLevel ?? "-",
			model.contextWindow,
			model.maxTokens,
			model.compat.reasoningDisableMode ?? "-",
		].join("\t"),
	);
}
console.log(`\n${models.length} models, ${skipped.length} skipped`);
for (const entry of skipped) console.log(`  skip ${entry.id || "(no id)"}: ${entry.reason}`);
