# ARK → pi field mapping

The same mapper feeds pi (`@earendil-works/pi-coding-agent` 1.4.0); only the last
step differs. `src/ark.ts` produces omp rows, `src/pi.ts` converts those rows to
pi's `ProviderModelConfig`, and `src/index.ts` picks the branch from the extension
API it is handed.

Install for pi either as a package (`pi install
git:github.com/trulyliu/pi-provider-arkcli`, or `pi install ./` from a clone) or
per invocation (`pi -e <dir>`); `package.json` declares
`pi.extensions: ["./src/index.ts"]`, so a clone is loadable with no build step.

Host detection, measured on both:

| API | omp | pi |
|---|---|---|
| `registerVirtualModel` | `undefined` | function |
| `logger` | object | `undefined` |
| `getSettings` | `undefined` | function |
| `fetchDynamicModels` honoured | yes (merged into `models`) | ignored |
| `refreshModels` honoured | ignored | yes (replaces `models`) |

`isPiHost()` keys off `registerVirtualModel`, the narrowest of those.

## Field differences

| Fact | omp field | pi field |
|---|---|---|
| registration key | `fetchDynamicModels(apiKey)` | `refreshModels(context)` |
| key reference | `"ARK_API_KEY"` (bare env name) | `"$ARK_API_KEY"` (pi interpolates) |
| thinking | `thinking: {mode, efforts, defaultLevel}` | `reasoning: boolean` + `thinkingLevelMap` |
| off switch | `compat.reasoningDisableMode: "none-effort"` | `thinkingLevelMap.off = "none"` |
| token field | `compat.maxTokensField: "max_tokens"` | same, but **must be explicit** |
| embedding | `kind: "embedding"` on `openai-embeddings` | no such type — row dropped |
| image | `kind: "image"` on `openai-images` | `type: "image"` + a custom `api` |
| cost | `{input,output,cacheRead,cacheWrite}` | same shape, all four required |

pi accepts omp's extra keys and ignores them, and omp accepts pi's; the configs
are a superset, not two files.

## `thinkingLevelMap`

pi derives the dialable levels from the map itself (`getSupportedThinkingLevels`):
a level mapped to `null` is not offered, `xhigh`/`max` count only when given a
value, and a requested-but-unsupported level is clamped up then down. So the map
must state every level ARK does *not* advertise:

| ARK `effort.supported_levels` | `thinkingLevelMap` |
|---|---|
| `["low","high","max"]` | `{off:"none", minimal:null, low:"low", medium:null, high:"high", xhigh:null, max:"max"}` |
| `["low","medium","high"]` | `{off:"none", minimal:null, low:"low", medium:"medium", high:"high", xhigh:null, max:null}` |
| none (no ladder) | absent, and `reasoning: false` |

`off: "none"` is not cosmetic. pi has no `reasoningDisableMode`: with
`reasoning: true`, no requested effort, and a string at `thinkingLevelMap.off`, pi
sends `reasoning_effort` equal to that string (`openai-completions.js`, the
`!options.reasoningEffort` branch). ARK accepts `"none"` and returns no reasoning
content, which is exactly the off behaviour omp gets from `none-effort`.

Verified on `deepseek-v4-1-flash-261017` through the capture proxy:
`--thinking high` → `reasoning_effort: "high"`, `--thinking off` → `"none"`,
`--thinking max` → `"max"`, all with `max_tokens: 393216`.

## Why `compat.maxTokensField` is mandatory on pi

pi's `detectCompat` has no ARK special case, so ARK's hostname lands in the
"standard OpenAI" bucket and gets `maxTokensField: "max_completion_tokens"`. ARK
rejects a request carrying both fields:

```
400 max_tokens and max_completion_tokens cannot be set at the same time
```

Every chat row therefore pins `compat.maxTokensField: "max_tokens"`. The other
detected values need no override: `supportsStore`, `supportsDeveloperRole`,
`supportsReasoningEffort` (`thinkingFormat: "openai"`) all match what ARK accepts,
each probed with a 200.

## Refresh lifecycle (pi-only constraint)

pi calls `refreshModels` three times per process, and only interactive mode ever
reaches the network:

| mode | `allowNetwork` | `credential` | consequence |
|---|---|---|---|
| `--list-models` | `false` (×3) | `type: "none"` | must serve the persisted catalog |
| `-p` | `false` (×3) | `type: "none"` | same |
| interactive TUI | `false` (×3), then `true` | `api_key` | refreshes, then persists |

Measured by logging each call from a probe extension; the interactive network call
arrives ~3 s after the UI starts (`interactive-mode.js` schedules
`refreshModelCatalogs` after `init()`, in parallel with the version check).

`refreshPiModels` reads the shared discovery cache first: a hit is returned
without touching the network, so even the interactive `allowNetwork: true` call
answers in ~1 ms and refreshes behind the session only when the entry is older
than the TTL. A miss falls back to `context.stored.models` (pi's own store) when
the network is not allowed, and otherwise fetches. Failures return the stored
rows: a throw would surface as a provider-wide refresh error.

Two stores exist and both are needed:

| store | written by | read by |
|---|---|---|
| `<agent dir>/models-store.json` | `context.publish({persist})` | pi itself, via `context.stored` |
| `<cache dir>/models-<hash>.json` | the extension, on every successful fetch | both hosts, before any network |

Returning a list alone does not persist it; only `publish({persist})` writes pi's
store. Observed: after one interactive session the store held 32 `arkcli` rows
(27 chat + 5 image), and a later `-p` run logged `stored=32` and resolved the
model. Observed with a warm extension cache and a *fresh* agent dir:
`pi --list-models` showed the same 27 chat rows in 0.95 s with zero requests, so
`-p` no longer requires a prior interactive run once the cache exists.

## Image generation

pi's built-in image API is `openrouter-images` (chat completions with
`modalities: ["image"]`, response in `choices[0].message.images`). ARK instead
serves `POST /images/generations`:

```json
{"model":"doubao-seedream-5-0-260128","prompt":"a red cube","response_format":"b64_json"}
```

`src/pi-images.ts` implements that as `ark-images`, mapped from the same
`ImageContent[]` pi passes in: text parts join into `prompt`, image parts become
`data:<mime>;base64,<data>` entries of `image` (ARK's reference-image form), and
`data[].b64_json` + `output_format` become `{type:"image", data, mimeType}` blocks.

Not verified end-to-end: every `doubao-seedream-*` id in the catalog is closed to
account 2108406384 —

```
doubao-seedream-5-5-261028      -> Your account 2108406384 has not activated the model
doubao-seedream-5-0-flash-260915-> Your account 2108406384 has not activated the model
doubao-seedream-5-0-260128      -> The model or endpoint … does not exist or you do not have access
doubao-seedream-4-5-251128      -> (same)
doubao-seedream-4-0-250828      -> (same)
```

The request body itself *is* verified (captured: `{model, prompt,
response_format:"b64_json"}`, correctly formed, 404 from ARK). Access is an account
provisioning issue, so the runner stays registered and documented as code-only.

Image models also never appear in `--list-models` or `/model` — pi reaches them
through `models.generateImages()` in codemode. That is pi's design, not a
registration failure.
