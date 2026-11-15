# AGENTS.md

This repo is `pi-provider-arkcli`, a provider extension for Volcengine ARK
(火山方舟), loaded by **pi** (`@earendil-works/pi-coding-agent`) and **omp**
(oh-my-pi). The job is narrow: turn `GET /api/v3/models` rows into host model rows
so context window, vision, and thinking levels survive. When the user says "update
the plugin according to the docs", follow this file.

`src/index.ts` detects the host from the extension API and registers the matching
provider contract; `src/pi.ts` converts omp rows to pi configs, `src/pi-images.ts`
implements ARK's image endpoint for pi. See
[docs/pi-compatibility.md](docs/pi-compatibility.md) for the measured differences.

## Rules that cause silent, expensive failures

1. **Never guess a field.** Every mapping decision needs a live payload value or
   an API response. If a field's meaning is unclear, probe ARK and write down the
   observed value in `docs/ark-models-api.md`.
2. **Never put `video`/`audio` into `input`.** omp's schema accepts only `text`
   and `image`; one bad value disables *every* custom provider with
   `models.yml validation failed — custom providers disabled`.
3. **Never add `max_completion_tokens` alongside `max_tokens`.** ARK 400s.
   `compat.maxTokensField` stays `"max_tokens"`.
4. **Never inject `thinking: {type:"enabled"}` or `extraBody.thinking`.** It
   forces reasoning on and breaks `--thinking off`.
5. **`none` is not an effort.** It is ARK's off switch; it becomes
   `compat.reasoningDisableMode: "none-effort"`.
6. **Every reasoning row needs a disable mode.** Without it omp degrades to
   `lowest-effort`, which still thinks.
7. **Do not edit `~/.omp/agent/models.yml`** unless the user asked for it
   explicitly. The extension is the product; that file is the user's config.
8. **A failed discovery call must not throw.** Return `[]`; throwing disables the
   provider for the session.
9. **Never gate a kind on `modalities`.** ARK omits the whole `modalities` block
   on text-embedding rows (`doubao-embedding-large-text-250515`), so the
   embedding branch keys off `api_supported` alone. Gating it on
   `output_modalities == "embedding"` silently drops all four text embeddings.
10. **pi needs `$ARK_API_KEY`, omp needs `ARK_API_KEY`.** pi only interpolates
    `$NAME`/`${NAME}`/`!cmd`; a bare name becomes the literal key. Measured: a
    bare name reached the wire as a 12-char string, not the real key.
11. **Never omit `compat.maxTokensField` on a pi chat row.** pi's `detectCompat`
    has no ARK case and picks `max_completion_tokens`; ARK 400s when both token
    fields are present.
12. **Never register pi `models` *and* expect a merge.** `refreshModels` replaces
    the list; `models` must stay `[]` so the refresh is the only source.
13. **Never let `refreshModels` throw.** A throw is a provider-wide refresh
    error; return `context.stored` rows and log instead.
14. **Never assume `--list-models`/`-p` see the network.** They always get
    `allowNetwork: false` and no credential; only interactive mode refreshes.

## Update procedure

### 1. Capture the current payload

```bash
ARK_API_KEY=ark-... node scripts/snapshot-ark-models.ts
# behind a proxy:
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 ARK_API_KEY=ark-... \
  node scripts/snapshot-ark-models.ts
```

This rewrites `test/fixtures/ark-models.sample.json`.

### 2. Diff the payload against the documented shape

```bash
git diff --stat test/fixtures/ark-models.sample.json
```

Look specifically for:

| Change | Action |
|---|---|
| new `modalities.input_modalities` value | decide: keep (`text`/`image`) or drop. Update `mapInput`. |
| new `api_supported` key | decide whether an omp transport exists. Update `mapApi` and the table in `docs/field-mapping.md`. |
| new `effort.supported_levels` value | add to `OMP_EFFORT_LADDER` only if omp accepts it; otherwise it is filtered. |
| new `domain` value | ignore unless it changes transport selection. |
| rows losing `context_window`/`max_output_tokens` | confirm the fallback is intended. |
| `features.thinking.type` vs `types` | both must remain readable; do not read either for gating. |

### 3. Update the mapper

`src/ark.ts` is pure (no host imports) and is the only place ARK→model mapping
lives. `src/discovery.ts` owns HTTP. `src/pi.ts` converts omp rows to pi configs
and `src/pi-images.ts` owns pi's image runner (also import-free so omp can parse
it). `src/index.ts` owns host detection and registration.

Keep this split: tests import these modules directly with Node's type stripping,
and omp must be able to parse every file in `src/` even though it never calls the
pi ones.

### 4. Update the docs

| File | What changes |
|---|---|
| `docs/ark-models-api.md` | observed enums, counts, invariants, doc-vs-live mismatches |
| `docs/field-mapping.md` | the field table and the reason for any new rule |
| `docs/pi-compatibility.md` | pi field differences, refresh lifecycle, image runner |
| `docs/ark-known-limits.md` | new server-side limits or fixed ones |
| `README.md` | only user-visible behaviour (install, flags, capability table) |
| `docs/verification.md` | new commands/expected values if a check changed |

Any claim added to docs must name how it was observed (endpoint response, wire
capture, or host output).

### 5. Verify

```bash
npm test                              # node --test "test/*.test.ts"
node scripts/dump-mapped-models.ts    # eyeball the table, then check skips
```

Then the end-to-end checks in `docs/verification.md`:

```bash
rm -f /tmp/arkcheck/models.db
env -u OMP_PROFILE -u PI_PROFILE PI_CODING_AGENT_DIR=/tmp/arkcheck \
  omp models --kind all --json -e "$PWD/src/index.ts" \
  | jq '.models[] | select(.id=="deepseek-v4-1-flash-261017")'
```

`--kind all` is mandatory: `omp models --json` is the chat catalog only, so image
rows are invisible and a correct registration looks broken.

Assert `1048576 / 393216 / ["text","image"] / thinking ["low","high","max"]`.

Wire-level, which is what `omp models --json` cannot prove:

```bash
ARK_API_KEY=ark-... npm run verify:wire     # high -> "high", off -> "none"
ARK_API_KEY=ark-... npm run verify:vision   # image_url present, OCR answer correct
```

Both scripts start `scripts/capture-proxy.py` on a free port, point `ARK_BASE_URL`
at it, and assert on the captured bodies:
`--thinking high` → `reasoning_effort: "high"`, `--thinking off` → `"none"`, the
advertised `max_tokens`, no `max_completion_tokens`, no `thinking` body field, and
an `image_url` part for the vision turn. If `ARK_BASE_URL` is not honoured, the
scripts fail with "no chat request captured" — that is a real regression, not a
flaky test.

Do not report a mapping change as done without the wire capture: `omp models
--json` alone does not prove what omp sends.

pi needs its own checks, because its model list is persisted rather than fetched
per run:

```bash
# 1. registration: 27 rows, after one interactive session has persisted them
PI_CODING_AGENT_DIR=/tmp/picheck pi -e "$PWD/src/index.ts"   # let it start, Ctrl-C
PI_CODING_AGENT_DIR=/tmp/picheck pi --list-models -e "$PWD/src/index.ts" | grep -c '^arkcli'

# 2. wire: high/off/max -> high/none/max, max_tokens advertised, no max_completion_tokens
ARK_API_KEY=ark-... npm run verify:pi-wire
```

`--list-models` and `-p` never call ARK: they always receive
`allowNetwork: false`. So an empty list there means "no interactive run has
persisted a catalog yet" (or the interactive refresh failed — check
`/tmp/pi-wire-tui.log`), not that registration is broken.

`pi update --models` is **not** a shortcut here: it builds a `ModelRuntime` with
the built-in providers only (`package-manager-cli.js` → `refreshModelCatalogs`),
so it prints `Model catalogs refreshed` and leaves `arkcli` at 0 rows. Only an
interactive session loads extensions and therefore publishes this catalog.

### 6. Update this file when the procedure changes

If a step moved, a command changed, or a new trap appeared, edit AGENTS.md in the
same commit. A future run should not need to rediscover anything written here.

## Debugging checklist

| Symptom | Check |
|---|---|
| capabilities still 128K / text-only | stale `<agentdir>/models.db`; `-e` path wrong; provider id mismatch |
| an image model "missing" | `omp models --json` without `--kind all` (chat-only view) |
| nothing loads without `-e` | symlink is not under `<agent dir>/extensions`; a sibling `extensions/` next to the agent dir is not scanned |
| `models.yml validation failed` | an invalid `input` value (`video`/`audio`) |
| provider missing entirely | `apiKey` not set (`ARK_API_KEY` unset) — omp requires it to register models |
| `--thinking off` still thinks | `reasoningDisableMode` missing; or a `whenThinking`/`extraBody` injected thinking |
| model absent from the list | row skipped: run `dump-mapped-models.ts` and read the skip reason |
| 400 `InvalidParameter` on every call | both `max_tokens` and `max_completion_tokens` sent |
| `ToolNotOpen` | ARK search component not activated on the account |

pi-only:

| Symptom | Check |
|---|---|
| `--list-models` shows no `arkcli` rows | no interactive session has persisted a catalog yet; run `pi -e <entry>` once, then retry |
| `pi update --models` printed success but rows are still 0 | expected: it only refreshes built-in catalogs; use an interactive session |
| extension does not load from a clone | `package.json` must keep `pi.extensions: ["./src/index.ts"]`; `pi -e <dir>` relies on it |
| interactive run shows errors but no rows | `<agent dir>/models-store.json` unwritten — look for the refresh warning; a throw here is the cause |
| 401 on the first turn | `apiKey` lost its `$` (pi used the bare name as the key) |
| 400 on every turn | `compat.maxTokensField` not pinned to `max_tokens` |
| `--thinking off` still thinks | `thinkingLevelMap.off` is `null`/absent instead of `"none"` |
| image model "missing" from `/model` | expected: pi never lists image models; use `models.generateImages()` |
| models vanish after an edit | `refreshModels` returned `[]` instead of the stored rows |

## Invariants to keep

- `src/ark.ts`, `src/pi.ts` and `src/pi-images.ts` import nothing from either
  host, so they run under plain Node and omp can parse them.
- `mapArkModel` never emits `input` values outside `["text","image"]`.
- `thinking` is omitted (not empty) when no level is dialable.
- `kind` matches what `api` can serve.
- Discovery is one HTTP GET; `fetchDynamicModels` has a 15 s budget.
- The pi branch never throws from `refreshModels` and never returns a list it
  cannot also persist.
- Host detection is API-shape only (`registerVirtualModel`); no host package is
  imported.
