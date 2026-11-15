# pi-provider-arkcli

Provider extension for Volcengine ARK / 火山方舟, for **pi**
(`@earendil-works/pi-coding-agent`) and **omp** (oh-my-pi). Registers the
`arkcli` provider and maps `GET /api/v3/models` onto each host's model rows.

Without this extension, omp's built-in `openai-models-list` discovery cannot read
ARK's payload, so every ARK model is registered with **128K context, text-only
input, and no thinking ladder** (and pi has no `arkcli` provider at all). With it,
a 1M-context VLM is registered as one:

| | built-in discovery | this extension |
|---|---|---|
| `deepseek-v4-1-flash-261017` context | 128000 | **1048576** |
| max output tokens | 16384 | **393216** |
| input | `["text"]` | **`["text","image"]`** |
| thinking levels | none | **`low`/`high`/`max`** |
| `--thinking off` wire value | `reasoning_effort: low` (still thinks) | **`reasoning_effort: "none"`** |

## Install

Requires an ARK API key, plus pi 1.4.0+ or omp 18.20+ (both load `.ts`
extensions in-process).

[github.com/trulyliu/pi-provider-arkcli](https://github.com/trulyliu/pi-provider-arkcli)

### pi

Install it as a pi package — pi clones the repo and records it in
`~/.pi/agent/settings.json`:

```bash
pi install git:github.com/trulyliu/pi-provider-arkcli
```

Update it later with `pi update git:github.com/trulyliu/pi-provider-arkcli`, and
remove it with `pi remove git:github.com/trulyliu/pi-provider-arkcli`.

Or load the checkout without installing, one invocation at a time:

```bash
git clone https://github.com/trulyliu/pi-provider-arkcli ~/src/pi-provider-arkcli
pi -e ~/src/pi-provider-arkcli                     # a directory follows package discovery
pi -e ~/src/pi-provider-arkcli/src/index.ts        # or point at the entry file
```

The repo declares `pi.extensions: ["./src/index.ts"]`, so a clone is a package
root and no build step runs before load.

Then export the key:

```bash
export ARK_API_KEY=ark-...
```

pi resolves `$ARK_API_KEY` itself; a key saved through pi's `/login` flow takes
precedence. `ARK_BASE_URL` switches region (default
`https://ark.cn-beijing.volces.com/api/v3`); ARK is regional, so the key must
belong to the same region.

**pi refreshes a live catalog only in interactive mode.** `--list-models` and
`-p` always call `refreshModels` with `allowNetwork: false` and no credential, so
they show whatever the last interactive session persisted in
`<agent dir>/models-store.json`. Run `pi` once (it refreshes a few seconds after
the UI starts, then Ctrl-C) before relying on `-p`. `pi update --models` does
**not** help here: it refreshes built-in catalogs only and never loads
extensions.

Verified: after one interactive session, `pi --list-models` shows 27 `arkcli`
chat rows and the store holds 32 rows (27 chat + 5 image).

### omp

```bash
git clone https://github.com/trulyliu/pi-provider-arkcli ~/src/pi-provider-arkcli
mkdir -p ~/.omp/agent/extensions
ln -sfn ~/src/pi-provider-arkcli ~/.omp/agent/extensions/pi-provider-arkcli
```

The extension root is `<agent dir>/extensions` — `~/.omp/agent/extensions` by
default, or `$PI_CODING_AGENT_DIR/extensions`. Each entry is a `.ts`/`.js` file, a
directory with `index.ts`/`index.js`, or a directory whose `package.json` declares
`omp.extensions` (this repo does). Symlinked directories are followed, so the
clone stays a clone.

Verified: with only a symlink there,
`omp models --kind all` lists 27 chat + 5 image + 4 embedding `arkcli` rows and no
`-e` flag.

Or point omp at the entry file without installing:

```bash
omp -e ~/src/pi-provider-arkcli/src/index.ts models
```

omp uses the same `ARK_API_KEY` fallback; a key saved through omp's `/login` flow
takes precedence.

### pi field differences

pi loads the same file through the same default-export convention, and the
extension detects the host from the API it is handed (`registerVirtualModel` is
pi-only). pi's provider fields differ: `refreshModels` instead of
`fetchDynamicModels`, `$ENV_VAR` key references instead of a bare env name, and
`reasoning` + `thinkingLevelMap` instead of a `thinking` ladder.

Details: [docs/pi-compatibility.md](docs/pi-compatibility.md).

| capability | omp | pi |
|---|---|---|
| chat rows discovered live | 27 | 27 |
| image rows | 5, `openai-images` | 5, `ark-images` (not listed by `--list-models`; server-side not reachable on this account) |
| embedding rows | 4, `openai-embeddings` | dropped — pi has no embedding model type |
| `--thinking off` | `reasoning_effort: "none"` | `reasoning_effort: "none"`, via `thinkingLevelMap.off` |
| `max_tokens` | pinned by `compat.maxTokensField` | pinned the same way (pi would otherwise auto-detect `max_completion_tokens` for ARK's hostname) |

## Use

```bash
# pi: the model must be in the store, so run once interactively first.
pi --model arkcli/deepseek-v4-1-flash-261017:high "explain this @screenshot.png"
pi -p --no-session --model arkcli/deepseek-v4-1-flash-261017:off "quick question"

# omp: `--kind all` matters, the catalog is multi-kind and `--json` defaults to chat only.
omp models --kind all --json | jq '.models[] | select(.provider=="arkcli") | {id, contextWindow, maxTokens, input, thinking}'
omp --model arkcli/deepseek-v4-1-flash-261017 "explain this @screenshot.png"
omp --model arkcli/deepseek-v4-1-flash-261017 --thinking off "quick question"
```

Thinking levels come from each model's `effort.supported_levels`; `off` maps to
`reasoning_effort: "none"`, which ARK honours as a real off switch. In pi the
level is part of the model spec (`<provider>/<model>:<level>`) or the
`--thinking` flag.

## How it maps ARK's payload

omp and ARK disagree on three field names. That is the whole bug:

| Fact | ARK field | omp reads (built-in) |
|---|---|---|
| context window | `token_limits.context_window`, `context_window` | `max_model_len`, `context_length`, `metadata.context_window` |
| input modalities | `modalities.input_modalities` | `input` / `input_modalities` / `architecture.input_modalities` |
| reasoning levels | `effort.supported_levels`, `effort.default_level` | `supported_reasoning_levels`, `default_reasoning_level` |

Full per-field table with the rationale for every decision:
[docs/field-mapping.md](docs/field-mapping.md).

## Model support

`GET /api/v3/models` returns every model version visible to the account, across
five disjoint API surfaces. This extension registers the three that have a
transport and skips the rest:

| ARK surface | omp `api` | pi `api` | registered |
|---|---|---|---|
| `chat/completions` | `openai-completions` | `openai-completions` | yes (chat) |
| `images/generations` | `openai-images` | `ark-images` | yes (image) |
| `embeddings` (text) | `openai-embeddings` | — | omp only (embedding) |
| `contents/generations` (video / 3D) | — | — | skipped |
| `embeddings/multimodal` | — | — | skipped |

Live counts: omp 27 chat + 5 image + 4 text-embedding = 36 rows (18 skipped); pi
27 chat + 5 image = 32 stored rows, of which `--list-models` shows the 27 chat
ones. Skipped rows are expected, not failures;
`node scripts/dump-mapped-models.ts` lists them with a reason.

## Web search

The payload carries `features.tools.web_search` per model, but **this extension
cannot wire it up**: omp reads native web search from a catalog field
(`webSearch`), which `models.yml` and dynamic rows do not accept. `webSearch`
also needs ARK's search component activated on the account. See
[docs/ark-known-limits.md](docs/ark-known-limits.md#web-search).

## Development

No build step; both hosts load `src/index.ts` directly (omp via Bun, pi via
Node's type stripping). Node 22.6+ runs the same files for tests:

```bash
node --test "test/*.test.ts"        # 53 tests: mapping, discovery, registration, pi
node scripts/dump-mapped-models.ts  # review the mapping as a table
```

Refresh the captured payload after an ARK change:

```bash
ARK_API_KEY=ark-... node scripts/snapshot-ark-models.ts
# behind a proxy:
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 ARK_API_KEY=ark-... \
  node scripts/snapshot-ark-models.ts
```

End-to-end checks (they assert on the request bodies the host actually sends, via
`scripts/capture-proxy.py`):

```bash
ARK_API_KEY=ark-... npm run verify:wire       # omp: high -> "high", off -> "none"
ARK_API_KEY=ark-... npm run verify:vision     # omp: image part present, code read back
ARK_API_KEY=ark-... npm run verify:pi-wire    # pi: high/off/max -> high/none/max
```

The pi script warms the catalog in a pseudo-terminal first, because `-p` alone
never refreshes over the network.

See [AGENTS.md](AGENTS.md) for the update procedure and
[docs/verification.md](docs/verification.md) for the full command list.
