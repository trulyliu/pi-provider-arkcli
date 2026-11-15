#!/usr/bin/env bash
# Wire-level assertion: what omp actually sends to ARK for each thinking level.
#
#   ./scripts/verify-wire.sh [model-id]
#
# Starts a capture proxy, points the extension at it via ARK_BASE_URL, runs two
# single-turn sessions, and asserts on the captured request bodies. Exits non-zero
# on the first mismatch.
set -euo pipefail

MODEL="${1:-deepseek-v4-1-flash-261017}"
# A fixed port silently reuses a stale proxy; let the kernel pick one unless asked.
PORT="${CAPTURE_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')}"
LOG="$(mktemp -t ark-wire.XXXXXX.jsonl)"
AGENT_DIR="$(mktemp -d -t ark-agent.XXXXXX)"
CACHE_DIR="$(mktemp -d -t arkcli-cache.XXXXXX)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${ARK_API_KEY:?ARK_API_KEY must be set}"

cleanup() {
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
  rm -rf "$AGENT_DIR" "$CACHE_DIR"
}
trap cleanup EXIT

CAPTURE_PORT="$PORT" CAPTURE_LOG="$LOG" python3 "$REPO/scripts/capture-proxy.py" \
  >/tmp/ark-capture-proxy.out 2>&1 &
PROXY_PID=$!
for _ in $(seq 50); do
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "capture proxy died; see /tmp/ark-capture-proxy.out" >&2
    exit 1
  fi
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/models" \
    -H "Authorization: Bearer $ARK_API_KEY" && break
  sleep 0.2
done

# What discovery advertises is what must reach the wire; read it from omp itself
# rather than hard-coding a number per model.
EXPECTED_MAX="$(env -u OMP_PROFILE -u PI_PROFILE PI_CODING_AGENT_DIR="$AGENT_DIR" \
  ARKCLI_CACHE_DIR="$CACHE_DIR" \
  omp models --json -e "$REPO/src/index.ts" \
  | python3 -c 'import json,sys; rows=json.load(sys.stdin)["models"]; print(next((r["maxTokens"] for r in rows if r["id"]==sys.argv[1]), ""))' "$MODEL")"
if [[ -z "$EXPECTED_MAX" ]]; then
  echo "model $MODEL is not advertised by the extension" >&2
  exit 1
fi
echo "advertised maxTokens for $MODEL: $EXPECTED_MAX"

run_turn() {
  local level="$1"
  : >"$LOG"
  env -u OMP_PROFILE -u PI_PROFILE \
    PI_CODING_AGENT_DIR="$AGENT_DIR" ARKCLI_CACHE_DIR="$CACHE_DIR" \
    ARK_BASE_URL="http://127.0.0.1:$PORT" \
    omp -p --no-session --no-tools --no-lsp --no-skills --no-rules --no-context-files \
    -e "$REPO/src/index.ts" --model "arkcli/$MODEL" --thinking "$level" \
    "Reply with just: ok" >/dev/null
}

assert_wire() {
  local level="$1" expected_effort="$2"
    python3 - "$LOG" "$expected_effort" "$level" "$EXPECTED_MAX" <<'PY'
import json, sys
log, expected, level, advertised = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
bodies = [json.loads(line) for line in open(log, encoding="utf-8") if line.strip()]
chats = [body for body in bodies if "messages" in body]
if not chats:
    sys.exit(f"--thinking {level}: no chat request captured")
body = chats[-1]
problems = []
if body.get("reasoning_effort") != expected:
    problems.append(f"reasoning_effort={body.get('reasoning_effort')!r}, want {expected!r}")
max_tokens = body.get("max_tokens")
if not isinstance(max_tokens, int) or max_tokens <= 0:
    problems.append(f"max_tokens={max_tokens!r}, want a positive int")
elif max_tokens != advertised:
    problems.append(f"max_tokens={max_tokens}, want the advertised {advertised}")
if "max_completion_tokens" in body:
    problems.append("max_completion_tokens present (ARK 400s when both are set)")
if "thinking" in body:
    problems.append(f"thinking body field present: {body['thinking']!r}")
if problems:
    sys.exit(f"--thinking {level}: " + "; ".join(problems))
print(f"ok  --thinking {level:<4} -> reasoning_effort={expected!r} max_tokens={body.get('max_tokens')}")
PY
}

run_turn high
assert_wire high high
run_turn off
assert_wire off none

echo "wire assertions passed for arkcli/$MODEL"
