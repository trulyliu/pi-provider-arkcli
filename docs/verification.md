# Verification

Every command below was run on omp 18.20.0 and pi 1.4.0 with a real ARK key.
Expected values are copied from observed output, not guessed.

Three of the checks are scripts, because "what the host sends" is the only claim
worth asserting and a capture proxy is the only way to see it.

## 0. Unit tests (no network, no key)

```bash
npm test          # or: node --test "test/*.test.ts"
```

Expect `pass 77`, `fail 0`. These pin the mapping rules against the captured
payload, the discovery/registration contract (including that `ARK_BASE_URL` is
honoured), the discovery cache (keys, TTL, isolation, one-shot gating), pi's row
conversion, and pi's image request/response shape, so a regression fails without
spending tokens. Every test that discovers models points `ARKCLI_CACHE_DIR` at a
fresh `mkdtemp` directory, so the suite never reads or writes the user's cache.

## 0b. Startup does not block on ARK

Discovery is cached per endpoint+key. Nothing here spends a token; the point is
that a start only waits for ARK the first time.

The cache is keyed by endpoint **and** key, so both runs must use the same
`ARK_BASE_URL`. Do the cold run through the capture proxy, then replace the proxy
with a listener that accepts and never answers.

```bash
PORT=19777
CAPTURE_PORT=$PORT CAPTURE_LOG=/tmp/ark-cold.jsonl python3 scripts/capture-proxy.py >/dev/null 2>&1 &
sleep 1

# Cold cache: one /models request, the only run allowed to wait.
rm -rf /tmp/arkcache /tmp/arkslow
ARKCLI_CACHE_DIR=/tmp/arkcache PI_CODING_AGENT_DIR=/tmp/arkslow ARK_BASE_URL=http://127.0.0.1:$PORT \
  omp models --kind all --json -e "$PWD/src/index.ts" \
  | jq '[.models[]|select(.provider=="arkcli")]|length'          # 36
kill %1

# Warm cache, dead endpoint: no request is made, so nothing can wait.
nc -lk 127.0.0.1 $PORT >/dev/null &
rm -rf /tmp/arkwarm
time ARKCLI_CACHE_DIR=/tmp/arkcache PI_CODING_AGENT_DIR=/tmp/arkwarm ARK_BASE_URL=http://127.0.0.1:$PORT \
  omp models --kind all --json -e "$PWD/src/index.ts" \
  | jq '[.models[]|select(.provider=="arkcli")]|length'          # 36
```

A cache **miss** against that dead endpoint is the allowed first run and does
wait (~15 s cap); delete `/tmp/arkcache` to observe it. A *failed* attempt is
remembered for 5 minutes, so the start after a failure does not wait again:

```bash
rm -rf /tmp/arkcache /tmp/arkfail1 /tmp/arkfail2
ARKCLI_CACHE_DIR=/tmp/arkcache PI_CODING_AGENT_DIR=/tmp/arkfail1 ARK_BASE_URL=http://127.0.0.1:1 \
  omp models --json -e "$PWD/src/index.ts" >/dev/null     # ~8 s baseline + failure path
cat /tmp/arkcache/*.json | jq -c '{rows: (.rows|length), failedAt}'   # rows 0, failedAt set
time ARKCLI_CACHE_DIR=/tmp/arkcache PI_CODING_AGENT_DIR=/tmp/arkfail2 ARK_BASE_URL=http://127.0.0.1:1 \
  omp models --json -e "$PWD/src/index.ts" >/dev/null     # no discovery wait
```

Measured, with `ARK_BASE_URL` pointed at a proxy that never answers `/models`:

| invocation | wall time |
|---|---|
| `omp models --json`, no extension | 8.1 s |
| same, extension + warm cache | 8.2 s |
| same, extension + cold cache | 17.0 s (the allowed first run) |
| `omp` TUI first paint, warm cache | 0.50 s |
| `pi` TUI first paint, warm cache | 0.30 s |

`omp models refresh` is the documented "force a fresh catalog" command, so it must
bypass the cache — otherwise it would silently serve the 6 h-old copy:

```bash
# warm cache + pass-through proxy: refresh re-queries ARK, listing does not
ARKCLI_CACHE_DIR=/tmp/arkcache ... omp models refresh -e "$PWD/src/index.ts"   # 1 request to /models
ARKCLI_CACHE_DIR=/tmp/arkcache ... omp models --json   -e "$PWD/src/index.ts"  # 0 requests
```

omp then rewrites its own `models.db`: `model_cache` holds one row for `arkcli`
(27 chat + 5 image + 4 embedding rows as JSON) and `model_cache_freshness.updated_at`
moves on every refresh. pi's equivalent is `context.force`, which returns through
the same path; the built-in pi UI does not set it yet.

A one-shot invocation must never start a refresh it cannot use (a pending fetch
delays exit — 22 s measured with a 20 s abort) and an interactive one must:

```bash
# one-shot: zero requests even with a stale cache
ARKCLI_CACHE_TTL_MS=0 ARKCLI_CACHE_DIR=/tmp/arkcache PI_CODING_AGENT_DIR=/tmp/arkoneshot \
  omp models --json -e "$PWD/src/index.ts" >/dev/null      # no request observed

# TUI: stale cache triggers exactly one request behind the UI
ARKCLI_CACHE_TTL_MS=0 ARKCLI_CACHE_DIR=/tmp/arkcache PI_CODING_AGENT_DIR=/tmp/arktui \
  omp -e "$PWD/src/index.ts"                               # Ctrl-C after ~15 s
```

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

## 4. pi registration and wire

pi needs its own checks: its model list is persisted, not fetched per run.

```bash
# 1. Load once interactively; the refresh runs a few seconds after the UI starts.
PI_CODING_AGENT_DIR=/tmp/picheck ARK_API_KEY=ark-... \
  pi -e "$PWD/src/index.ts"        # Ctrl-C after it settles

jq '.arkcli.models | length' /tmp/picheck/models-store.json   # want 32
PI_CODING_AGENT_DIR=/tmp/picheck pi --list-models -e "$PWD/src/index.ts" | grep -c '^arkcli'  # want 27

# 2. Wire: the same model, three thinking levels.
ARK_API_KEY=ark-... ./scripts/verify-pi-wire.sh
```

The script prints, and asserts on, this:

```
persisted arkcli rows: 32
advertised maxTokens for deepseek-v4-1-flash-261017: 393216
ok  --thinking high  -> reasoning_effort='high' max_tokens=393216
ok  --thinking off   -> reasoning_effort='none' max_tokens=393216
ok  --thinking max   -> reasoning_effort='max' max_tokens=393216
wire assertions passed for arkcli/deepseek-v4-1-flash-261017
```

pi calls `refreshModels` three times with `allowNetwork: false` and
`credential.type === "none"` for `--list-models` and `-p`; only the interactive
TUI (`interactive-mode.js` → `refreshModelCatalogs`) reaches `allowNetwork: true`
with `api_key`. Those one-shot calls read the shared discovery cache, so after the
first discovery anywhere (omp or pi, any agent dir) a fresh agent dir lists the
same rows with no network:

```bash
rm -rf /tmp/pifresh
PI_CODING_AGENT_DIR=/tmp/pifresh pi -e "$PWD/src/index.ts" --list-models | grep -c '^arkcli'  # 27
```

Measured: 0.95 s with `ARK_BASE_URL` pointed at an endpoint that never answers
`/models`. Before the cache existed this printed 0 until an interactive run had
persisted the store.

`pi update --models` does not substitute: it refreshes built-in catalogs only and
never loads extensions (measured: prints `Model catalogs refreshed`, store stays
empty).

Installing from the remote is equivalent to `-e`, and is what the README tells
users to run:

```bash
PI_CODING_AGENT_DIR=/tmp/piinstall pi install git:github.com/trulyliu/pi-provider-arkcli
jq -r '.packages[]' /tmp/piinstall/settings.json     # git:github.com/trulyliu/pi-provider-arkcli
PI_CODING_AGENT_DIR=/tmp/piinstall pi                # one interactive run, then Ctrl-C
PI_CODING_AGENT_DIR=/tmp/piinstall pi --list-models | grep -c '^arkcli'   # 27
```

`pi update git:github.com/trulyliu/pi-provider-arkcli` updates it and
`pi remove git:github.com/trulyliu/pi-provider-arkcli` removes it; both were run
against this repo. The same holds for omp's one-liner:

```bash
omp plugin install git:github.com/trulyliu/pi-provider-arkcli   # ✔ Installed pi-provider-arkcli@0.2.0
omp models --kind all --json | jq '[.models[]|select(.provider=="arkcli")]|length'   # 36, no -e
omp plugin upgrade pi-provider-arkcli    # picks up a new commit: "Upgraded … to a new revision"
omp plugin uninstall pi-provider-arkcli
```

## 5. Long context

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

## 6. Direct ARK probes (no host)

Useful when a mapping looks wrong and the question is whether ARK or the host is
at fault.

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

## 7. Refreshing the fixture

```bash
ARK_API_KEY=ark-... node scripts/snapshot-ark-models.ts
node scripts/dump-mapped-models.ts | head -20
```

Behind a proxy, prefix with `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=...`. Then re-run
step 0; a changed row count or a new skip reason means the mapping needs a look.
