# ARK `/api/v3/models` payload reference

Captured 2026-11-15 from `GET https://ark.cn-beijing.volces.com/api/v3/models`
(54 rows, whole account). Live sample:
[`test/fixtures/ark-models.sample.json`](../test/fixtures/ark-models.sample.json).

Auth: `Authorization: Bearer $ARK_API_KEY`. No pagination parameters; the full
visible list comes back in one response.

## Shape

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-1-flash-261017",
      "object": "model",
      "name": "deepseek-v4-1-flash",
      "version": "261017",
      "created": 1792226977,
      "domain": "VLM",
      "status": "Published",
      "task_type": ["text_generation"],
      "token_limits": {
        "context_window": 1048576,
        "max_input_token_length": 1048576,
        "max_output_token_length": 393216,
        "max_reasoning_token_length": 131072
      },
      "context_window": 1048576,
      "max_output_tokens": 393216,
      "modalities": {
        "input_modalities": ["text", "image", "video"],
        "output_modalities": ["text"]
      },
      "effort": { "default_level": "high", "supported_levels": ["low", "high", "max", "none"] },
      "features": {
        "thinking": { "types": ["enabled", "disabled"] },
        "tools": { "function_calling": true, "web_search": true },
        "structured_outputs": { "json_object": true, "json_schema": true },
        "cache": { "prefix_cache": true, "session_cache": true },
        "batch": { "batch_chat": false, "batch_job": true }
      },
      "api_supported": {
        "chat/completions": true,
        "messages": true,
        "responses": true,
        "tokenization": true
      }
    }
  ]
}
```

`deepseek-v4-1-flash-261017` is the row to check when testing a mapping change:
1M context, 393216 output, image input, and a `none` level.

## Enumerations observed

**`api_supported` keys** (row counts out of 54): `chat/completions` 27,
`responses` 20, `tokenization` 19, `messages` 18, `contents/generations` 7,
`images/generations` 5, `embeddings` 5, `embeddings/multimodal` 4,
`batch/chat/completions` 3, `systemone` 1. Values are booleans; absent means
unsupported.

**`domain`**: `LLM` 13, `VLM` 13, `VideoGeneration` 8, `ImageGeneration` 7,
`Embedding` 1, `Router` 1, `3DGeneration` 1, empty string 10.

**`status`**: `Published` 38, `Retiring` 16. `Retiring` rows still work; omp has
no field for lifecycle state, so they are registered normally.

**`modalities.input_modalities`** on the 27 chat rows: `[text,image,video]` 13,
`[text]` 11, and 3 that also list `audio` (in inconsistent order:
`[text,image,video,audio]` twice, `[text,video,image,audio]` once). So 16 chat
rows advertise video and 3 advertise audio — both are dropped by the mapper.

**`effort.supported_levels`** on the 27 chat rows: 8 rows have none
(`doubao-seed-character-251128`, `qwen3-14b-20250429`, `qwen3-0-6b-20250429`,
`doubao-smart-router-250928`, `qwen2-5-72b-20240919`, `qwen3-32b-20250429`,
`qwen3-8b-20250429`, `glm-4-5-air-20250728`); the rest carry 4–5 levels drawn
from `minimal`, `low`, `medium`, `high`, `max`, `none`.

## Invariants worth relying on

- `max_output_tokens` equals `token_limits.max_output_token_length` on every row
  that has both.
- `context_window` equals `token_limits.context_window` on every row that has
  both.
- Chat rows always succeed on `chat/completions` and always list `text` among
  `input_modalities` (it is omitted together with the whole limits block on
  `doubao-smart-router-250928`).
- `name` is shared across versions (`doubao-seed-2-0-pro` for several ids); only
  `id` is unique.

## Documented vs. observed

The contract documents `features.thinking.type` as a **string**
(`enabled`/`disabled`). The live payload returns
`features.thinking.types` as an **array**. Anything reading this field must accept
both; this extension does not read it at all (it derives reasoning support from
`effort`, which is per-version).

The contract lists `domain` as `LLM`/`VLM`/`ImageGeneration`/`VideoGeneration`/
`3DGeneration`/`Audio`/`Embedding`; live rows also return `Router` and `""`. Never
switch on `domain` alone — `api_supported` and `output_modalities` are what
determine the transport.

## Related endpoints that do not exist

`GET /api/v3/endpoints` returns 404. There is no models-list API for the account's
custom endpoints (`ep-*`); those must be configured by id.
