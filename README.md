# omp-provider-ark

omp (oh-my-pi) provider extension for Volcengine ARK / 火山方舟. Registers the
`arkcli` provider and maps `GET /api/v3/models` onto omp model rows.

Without this extension, omp's built-in `openai-models-list` discovery cannot read
ARK's payload, so every ARK model is registered with **128K context, text-only
input, and no thinking ladder**. With it, a 1M-context VLM is registered as one:

| | built-in discovery | this extension |
|---|---|---|
| `deepseek-v4-1-flash-261017` context | 128000 | **1048576** |
| max output tokens | 16384 | **393216** |
| input | `["text"]` | **`["text","image"]`** |
| thinking levels | none | **`low`/`high`/`max`** |
| `--thinking off` wire value | `reasoning_effort: low` (still thinks) | **`reasoning_effort: "none"`** |

## Install

Requires omp ≥ 18.20 (extensions are `.ts` files loaded in-process) and an ARK
API key.

```bash
git clone <this repo> ~/src/omp-provider-ark
mkdir -p ~/.omp/agent/extensions
ln -sfn ~/src/omp-provider-ark ~/.omp/agent/extensions/omp-provider-ark
```

Or point omp at the entry file without installing:

```bash
omp -e ~/src/omp-provider-ark/src/index.ts models
```

Then export the key:

```bash
export ARK_API_KEY=ark-...
```

`ARK_API_KEY` is the built-in fallback. A key saved through omp's own `/login`
flow takes precedence when present.

Optional: `ARK_BASE_URL` switches region (default
`https://ark.cn-beijing.volces.com/api/v3`). ARK is regional; the key must belong
to the same region.

## Use

```bash
# `--kind all` matters: the catalog is multi-kind and `--json` defaults to chat only.
omp models --kind all --json | jq '.models[] | select(.provider=="arkcli") | {id, contextWindow, maxTokens, input, thinking}'
omp --model arkcli/deepseek-v4-1-flash-261017 "explain this @screenshot.png"
omp --model arkcli/deepseek-v4-1-flash-261017 --thinking off "quick question"
```

Thinking levels come from each model's `effort.supported_levels`; `off` maps to
`reasoning_effort: "none"`, which ARK honours as a real off switch.

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
five disjoint API surfaces. This extension registers the three that have an omp
transport and skips the rest:

| ARK surface | omp `api` | registered |
|---|---|---|
| `chat/completions` | `openai-completions` | yes (chat) |
| `images/generations` | `openai-images` | yes (image) |
| `embeddings` (text) | `openai-embeddings` | yes (embedding) |
| `contents/generations` (video / 3D) | — | skipped |
| `embeddings/multimodal` | — | skipped |

Live counts: 27 chat + 5 image + 4 text-embedding = 36 rows; 18 skipped. Skipped
rows are expected, not failures; `node scripts/dump-mapped-models.ts` lists them
with a reason.

## Web search

The payload carries `features.tools.web_search` per model, but **this extension
cannot wire it up**: omp reads native web search from a catalog field
(`webSearch`), which `models.yml` and dynamic rows do not accept. `webSearch`
also needs ARK's search component activated on the account. See
[docs/ark-known-limits.md](docs/ark-known-limits.md#web-search).

## Development

No build step; omp loads `src/index.ts` directly with Bun. Node 22.6+ can run the
same files for tests (type stripping):

```bash
node --test "test/*.test.ts"        # 25 tests: mapping, discovery, registration
node scripts/dump-mapped-models.ts  # review the mapping as a table
```

Refresh the captured payload after an ARK change:

```bash
ARK_API_KEY=ark-... node scripts/snapshot-ark-models.ts
# behind a proxy:
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 ARK_API_KEY=ark-... \
  node scripts/snapshot-ark-models.ts
```

End-to-end checks (they assert on the request bodies omp actually sends, via
`scripts/capture-proxy.py`):

```bash
ARK_API_KEY=ark-... npm run verify:wire     # high -> "high", off -> "none"
ARK_API_KEY=ark-... npm run verify:vision   # image part present, code read back
```

See [AGENTS.md](AGENTS.md) for the update procedure and
[docs/verification.md](docs/verification.md) for the full command list.
