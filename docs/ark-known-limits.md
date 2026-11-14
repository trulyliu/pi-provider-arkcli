# ARK behaviour that constrains this plugin

Each entry was observed on this account. "Server-side limit" means no mapping
change can fix it; "documented mismatch" means the contract and the live payload
disagree.

## `max_tokens` and `max_completion_tokens` are mutually exclusive

Sending both returns `400 InvalidParameter`. omp can emit either, so
`compat.maxTokensField: "max_tokens"` is set on every row and is not optional.
Measured: with `max_tokens: 393216` alone the request succeeds and omp never adds
`max_completion_tokens`.

## `response_format: json_object` needs the word "json"

```json
{"error":{"code":"InvalidParameter",
  "message":"Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'."}}
```

Server-side, applies even when the prompt is obviously asking for JSON in another
language. `json_schema` has no such requirement and works.

## Unadvertised effort levels are accepted, not rejected

`xhigh` (absent from every ARK model) returns 200 with real reasoning tokens.
`none` returns 200 on models that do not advertise it. Consequence: the plugin
must not rely on ARK erroring out for unsupported levels; it filters to the
advertised ladder itself.

## Over-cap `max_tokens` is silently accepted

`max_tokens: 1000000` on a 393216-output model returns 200; ARK clamps
server-side. Do not clamp to the advertised cap for correctness, only to keep
omp's own accounting honest (`mapLimits` clamps to `min(output, contextWindow)`).

## Tool call history

- `tool_choice`: `auto`, `required`, a named function, and `"none"` all return
  200 with real `tool_calls` (except `"none"`, which returns a normal message).
  So `compat.supportsToolChoice: false` is wrong for ARK.
- An assistant turn with `content: ""` plus `tool_calls` and **no**
  `reasoning_content` is accepted. `requiresReasoningContentForToolCalls` and
  `requiresAssistantContentForToolCalls` are both unnecessary.
- `developer` and `system` roles both work; `supportsDeveloperRole` can stay
  default (omp sends `system` unless a compat flag says otherwise).

## Streaming

`stream: true` works with `stream_options.include_usage`, with tools, with
`parallel_tool_calls: false`, and with `store: false`. Frames end in
`data: [DONE]`.

## `features.thinking.type` vs `types`

The contract documents a string `type` (`enabled`/`disabled`); every live row
returns an array `types: ["enabled","disabled"]`. Reading the wrong one yields
`undefined` for every model. This plugin derives reasoning support from `effort`
instead, which is per-version and unambiguous.

## Web search

`features.tools.web_search` is present per model (17 rows `true`), and ARK really
does support it: the Responses API accepts `tools: [{type: "web_search"}]`, and
the Chat API accepts `web_search_options: {}`.

Two blockers keep this plugin from wiring it up:

1. **Account activation.** Responses with `tools: [{type:"web_search"}]` returns
   `404 ToolNotOpen: Your account has not activated web search. You may activate
   it at https://console.volcengine.com/common-buy/CC_content_plugin`.
   Chat with `web_search_options: {}` returns 200 but no search happens
   (`tool_usage` absent, no `annotations`, the model says it cannot browse).
2. **omp has no per-model hook for it from an extension.** omp exposes native
   search as a catalog field (`webSearch: "openai"`) validated in
   `applyCatalogSettings`; `models.yml` model entries and dynamic rows both drop
   it silently (verified: a static `web_search: openai` model and a dynamic row
   carrying `webSearch` both come back from `omp models --json` without the field,
   and `/web` then falls back to omp's local search providers). omp's
   `webSearch: "openai"` backend also posts to `/{baseUrl}/responses` with
   OpenAI-shaped `web_search` tools, which would need ARK's Responses API plus the
   activation above.

So: capability is real, this extension cannot enable it, and enabling it also
costs money per search. `features.tools.web_search` is therefore **not** consumed
by the mapper — mapping it to something omp ignores would only mislead.

If omp later accepts `webSearch` on dynamic rows, the change is one line in
`mapArkModel`, gated on `features.tools.web_search === true`. Check
`docs/verification.md` step 2 first: whether omp honours the field is observable
from the captured request.

## Model access errors

| Error code | Meaning |
|---|---|
| `ModelNotOpen` | Model exists, account has not activated it in the ARK console. |
| `InvalidEndpointOrModel.NotFound` | No access to that id, or it does not exist. |

Both are per-account facts discovered from the `/models` list, not mapping bugs.
`GET /api/v3/endpoints` is 404 — there is no API to enumerate `ep-*` endpoints,
so those must be configured by id.

## `Retiring` models

16 of 54 rows are `Retiring`; they still serve requests. omp has no lifecycle
field, so they are registered like any other model. Filtering them out would be a
policy decision, not a capability one.
