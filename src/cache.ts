/**
 * On-disk copy of the last successful `GET /api/v3/models` payload.
 *
 * Both hosts call discovery inside a startup path (omp awaits
 * `fetchDynamicModels` with a 15 s budget; pi's model picker awaits
 * `refreshModels`), so a slow or unreachable ARK must not be paid twice. The
 * first run has nothing to serve and still waits; every run after it answers
 * from this file and refreshes behind the caller.
 *
 * Raw ARK rows are stored, not host rows: a mapping change then applies to an
 * existing cache instead of requiring a re-download.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ArkModelRow } from "./ark.ts";

/** Bumped when the stored shape changes; an older file is ignored, not migrated. */
export const MODEL_CACHE_VERSION = 1;

export interface ModelCacheEntry {
	version: number;
	baseUrl: string;
	checkedAt: number;
	rows: ArkModelRow[];
	/** Present when the last attempt failed; suppresses the next blocking retry. */
	failedAt?: number;
}

/**
 * `ARKCLI_CACHE_DIR` wins so tests and throwaway runs never touch the user's
 * cache. Otherwise XDG, then `~/.cache`.
 */
export function modelCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.ARKCLI_CACHE_DIR?.trim();
	if (override) return override;
	const xdg = env.XDG_CACHE_HOME?.trim();
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
	return join(base, "pi-provider-arkcli");
}

/**
 * One file per endpoint *and* key: two accounts on the same region see
 * different models, and the key itself never reaches the filename.
 */
export function modelCacheFile(baseUrl: string, apiKey: string, dir: string = modelCacheDir()): string {
	const digest = createHash("sha256").update(`${baseUrl}\n${apiKey}`).digest("hex").slice(0, 16);
	return join(dir, `models-${digest}.json`);
}

/** Never throws: a missing, unreadable, or corrupt cache is simply a miss. */
export async function readModelCache(path: string): Promise<ModelCacheEntry | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const entry = parsed as Partial<ModelCacheEntry>;
		if (entry.version !== MODEL_CACHE_VERSION) return undefined;
		if (typeof entry.checkedAt !== "number") return undefined;
		if (typeof entry.baseUrl !== "string") return undefined;
		if (!Array.isArray(entry.rows)) return undefined;
		const rows = entry.rows.filter(
			(row): row is ArkModelRow => !!row && typeof row === "object" && typeof (row as ArkModelRow).id === "string",
		);
		const failedAt = typeof entry.failedAt === "number" ? entry.failedAt : undefined;
		return {
			version: MODEL_CACHE_VERSION,
			baseUrl: entry.baseUrl,
			checkedAt: entry.checkedAt,
			rows,
			...(failedAt === undefined ? {} : { failedAt }),
		};
	} catch {
		return undefined;
	}
}

/** Never throws: a cache write failure must not fail discovery. */
export async function writeModelCache(path: string, entry: Omit<ModelCacheEntry, "version">): Promise<boolean> {
	try {
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify({ version: MODEL_CACHE_VERSION, ...entry })}\n`);
		await rename(temporary, path);
		return true;
	} catch {
		return false;
	}
}
