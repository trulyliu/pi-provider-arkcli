#!/usr/bin/env bash
# Wire-level assertion: what pi actually sends to ARK for each thinking level.
#
#   ./scripts/verify-pi-wire.sh [model-id]
#
# pi only refreshes a live model catalog in interactive mode: `--list-models` and
# `-p` always call `refreshModels` with `allowNetwork: false`. So the script
# first runs one interactive session under a pseudo-terminal (which publishes the
# catalog into pi's model store), then replays it with `-p`, and asserts on the
# request bodies captured by scripts/capture-proxy.py. Exits non-zero on the
# first mismatch.
set -euo pipefail

MODEL="${1:-deepseek-v4-1-flash-261017}"
PORT="${CAPTURE_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')}"
LOG="$(mktemp -t pi-wire.XXXXXX.jsonl)"
AGENT_DIR="$(mktemp -d -t pi-agent.XXXXXX)"
CACHE_DIR="$(mktemp -d -t arkcli-cache.XXXXXX)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$REPO/src/index.ts"

: "${ARK_API_KEY:?ARK_API_KEY must be set}"
command -v pi >/dev/null || { echo "pi is not on PATH" >&2; exit 1; }
command -v script >/dev/null || { echo "script(1) is required to warm the catalog" >&2; exit 1; }

cleanup() {
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
  rm -rf "$AGENT_DIR" "$CACHE_DIR"
}
trap cleanup EXIT

CAPTURE_PORT="$PORT" CAPTURE_LOG="$LOG" python3 "$REPO/scripts/capture-proxy.py" \
  >/tmp/pi-capture-proxy.out 2>&1 &
PROXY_PID=$!
for _ in $(seq 50); do
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "capture proxy died; see /tmp/pi-capture-proxy.out" >&2
    exit 1
  fi
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/models" \
    -H "Authorization: Bearer $ARK_API_KEY" && break
  sleep 0.2
done

export ARK_BASE_URL="http://127.0.0.1:$PORT"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
export ARKCLI_CACHE_DIR="$CACHE_DIR"

# Warm the catalog. Interactive mode schedules the network refresh after the UI
# starts, so the session must live a few seconds; Ctrl-C then exits it.
echo "warming the catalog through $ARK_BASE_URL (interactive)…"
( sleep 12; printf '\x03' ) | timeout 120 script -qec "env PI_CODING_AGENT_DIR=$AGENT_DIR ARKCLI_CACHE_DIR=$CACHE_DIR ARK_BASE_URL=$ARK_BASE_URL ARK_API_KEY=$ARK_API_KEY pi -e $EXT" \
  /tmp/pi-wire-tui.log >/dev/null 2>&1 || true

ROWS="$(python3 - "$AGENT_DIR/models-store.json" <<'PY'
import json, sys
try:
    store = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError):
    sys.exit(0)
print(len(store.get("arkcli", {}).get("models") or []))
PY
)"
if [[ "${ROWS:-0}" -eq 0 ]]; then
  echo "pi did not persist an arkcli catalog; interactive warm-up failed (see /tmp/pi-wire-tui.log)" >&2
  exit 1
fi
echo "persisted arkcli rows: $ROWS"

EXPECTED_MAX="$(python3 - "$AGENT_DIR/models-store.json" "$MODEL" <<'PY'
import json, sys
store = json.load(open(sys.argv[1], encoding="utf-8"))
models = store.get("arkcli", {}).get("models") or []
print(next((m.get("maxTokens", "") for m in models if m.get("id") == sys.argv[2]), ""))
PY
)"
if [[ -z "$EXPECTED_MAX" ]]; then
  echo "model $MODEL is not in pi's persisted catalog" >&2
  exit 1
fi
echo "advertised maxTokens for $MODEL: $EXPECTED_MAX"

run_turn() {
  local level="$1"
  : >"$LOG"
  pi -p --no-session --no-tools -e "$EXT" --model "arkcli/$MODEL" --thinking "$level" \
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
    sys.exit(f"pi --thinking {level}: no chat request captured")
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
if problems:
    sys.exit(f"pi --thinking {level}: " + "; ".join(problems))
print(f"ok  --thinking {level:<5} -> reasoning_effort={expected!r} max_tokens={body.get('max_tokens')}")
PY
}

run_turn high
assert_wire high high
# pi has no `reasoningDisableMode`; `thinkingLevelMap.off = "none"` is what turns
# reasoning off, and ARK accepts `reasoning_effort: "none"`.
run_turn off
assert_wire off none
run_turn max
assert_wire max max

echo "wire assertions passed for arkcli/$MODEL"
