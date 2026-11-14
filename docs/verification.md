# Verification

Every command below was run on omp 18.20.0 with a real ARK key. Expected values
are copied from observed output, not guessed.

Two of the checks are scripts, because "what omp sends" is the only claim worth
asserting and a capture proxy is the only way to see it.

## 0. Unit tests (no network, no key)

```bash
npm test          # or: node --test "test/*.test.ts"
```

Expect `pass 25`, `fail 0`. These pin the mapping rules against the captured
payload and the discovery/registration contract (including that `ARK_BASE_URL` is
honoured), so a regression fails without spending tokens.

## 1. Discovery produces the right capabilities

```bash
rm -f /tmp/arkcheck/models.db
env -u OMP_PROFILE -u PI_PROFILE PI_CODING_AGENT_DIR=/tmp/arkcheck \
  omp models --kind all --json -e "$PWD/src/index.ts" \
  | jq '.models[] | select(.id=="deepseek-v4-1-flash-261017")'
```

`--kind all` is required to see anything but chat models: `omp models --json`
defaults to the chat catalog, which silently hides the 5 `openai-images` rows and
would make a broken image mapping look like a missing feature.

`PI_CODING_AGENT_DIR` must be a scratch directory: omp caches discovery in
`<agentdir>/models.db` for 24 h, and a stale cache masks extension changes.
The `env -u` guards matter on this host — `OMP_PROFILE`/`PI_PROFILE` override
`PI_CODING_AGENT_DIR`.

Expected fields:

| field | value |
|---|---|
| `contextWindow` | `1048576` |
| `maxTokens` | `393216` |
| `input` | `["text","image"]` |
| `reasoning` | `true` |
| `thinking` | `["low","high","max"]` |

Row counts with `--kind all`: 36 `arkcli` rows — 27 `chat`, 5 `image`
(`doubao-seedream-4-0/4-5/5-0/5-0-flash/5-5`), 4 `embedding`
(`doubao-embedding-text-240515/240715`, `doubao-embedding-large-text-240915/250515`).
Without `--kind all` only the 27 chat rows appear.

## 2. Thinking level reaches the wire

```bash
ARK_API_KEY=ark-... ./scripts/verify-wire.sh
# or: npm run verify:wire
```

The script picks a free port, starts `scripts/capture-proxy.py`, runs one
`--thinking high` and one `--thinking off` session against
`--model arkcli/<id>`, and asserts on the captured bodies:

```
advertised maxTokens for deepseek-v4-1-flash-261017: 393216
ok  --thinking high -> reasoning_effort='high' max_tokens=393216
ok  --thinking off  -> reasoning_effort='none' max_tokens=393216
wire assertions passed for arkcli/deepseek-v4-1-flash-261017
```

Four properties are asserted, and each one was a real failure mode:

| assertion | why |
|---|---|
| `reasoning_effort` is `high` / `none` | without `none-effort`, `off` degrades to `low` and still thinks |
| `max_tokens` equals what discovery advertises | `maxTokensField` must be `max_tokens` |
| `max_completion_tokens` absent | ARK 400s when both are present |
| no `thinking` body field | injected `thinking.type` forces reasoning on |

## 3. Vision

```bash
ARK_API_KEY=ark-... ./scripts/verify-vision.sh
# or: npm run verify:vision
```

Uses `test/fixtures/ocr.png` (the text `ARK-7391`, regenerable with
`scripts/make-ocr-fixture.ts`) and asserts both that the request carries an
`image_url` part and that the answer contains the code:

```
ok  image on the wire and read back as ARK-7391
vision assertion passed for arkcli/deepseek-v4-1-flash-261017
```

A text-only registration fails this twice: no `image_url`, and the model replies
that it cannot see an image.

## 4. Long context

Needs a prompt above 128K tokens; the point is that omp accepts it at all. Observed
on this model: a 2.88 MB body returned HTTP 200 with `prompt_tokens: 641635`, and a
needle placed in the middle of the prompt was answered correctly. With the
128000 fallback, omp truncates or refuses before the request is sent.

```bash
python3 -c 'print("filler " * 90000 + "The secret code is HORIZON-42.")' > /tmp/long.txt
env -u OMP_PROFILE -u PI_PROFILE PI_CODING_AGENT_DIR=/tmp/arkcheck \
  omp -p --no-session --no-lsp --no-skills --no-rules --no-context-files \
  -e "$PWD/src/index.ts" --model arkcli/deepseek-v4-1-flash-261017 --thinking off \
  "What is the secret code? $(cat /tmp/long.txt)"
```

## 5. Direct ARK probes (no omp)

Useful when a mapping looks wrong and the question is whether ARK or omp is at
fault.

```bash
# What does ARK advertise?
curl -s https://ark.cn-beijing.volces.com/api/v3/models \
  -H "Authorization: Bearer $ARK_API_KEY" \
  | jq '.data[] | select(.id=="deepseek-v4-1-flash-261017")'

# Is the off switch real? (expect reasoning_tokens 0)
curl -s https://ark.cn-beijing.volces.com/api/v3/chat/completions \
  -H "Authorization: Bearer $ARK_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-1-flash-261017","messages":[{"role":"user","content":"hi"}],
       "max_tokens":64,"reasoning_effort":"none"}' \
  | jq '.usage.completion_tokens_details'
```

`ModelNotOpen` means the account has not activated that model — a console/billing
fact, not a mapping bug. `InvalidEndpointOrModel.NotFound` means no access or no
such version. Neither is fixed by editing the mapper.

## 6. Refreshing the fixture

```bash
ARK_API_KEY=ark-... node scripts/snapshot-ark-models.ts
node scripts/dump-mapped-models.ts | head -20
```

Behind a proxy, prefix with `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=...`. Then re-run
step 0; a changed row count or a new skip reason means the mapping needs a look.
