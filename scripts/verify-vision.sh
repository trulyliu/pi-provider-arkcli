#!/usr/bin/env bash
# End-to-end vision assertion: does discovery's `input: ["text","image"]` actually
# put an image on the wire, and can the model read it?
#
#   ./scripts/verify-vision.sh [model-id]
#
# Uses test/fixtures/ocr.png (the text `ARK-7391`) and asserts both the request
# body (an image part is present) and the answer (the code comes back).
set -euo pipefail

MODEL="${1:-deepseek-v4-1-flash-261017}"
# A fixed port silently reuses a stale proxy; let the kernel pick one unless asked.
PORT="${CAPTURE_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')}"
LOG="$(mktemp -t ark-vision.XXXXXX.jsonl)"
AGENT_DIR="$(mktemp -d -t ark-agent.XXXXXX)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="$REPO/test/fixtures/ocr.png"
EXPECTED_CODE="ARK-7391"

: "${ARK_API_KEY:?ARK_API_KEY must be set}"
[[ -f "$IMAGE" ]] || { echo "missing $IMAGE" >&2; exit 1; }

cleanup() {
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
  rm -rf "$AGENT_DIR"
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

ANSWER="$(env -u OMP_PROFILE -u PI_PROFILE \
  PI_CODING_AGENT_DIR="$AGENT_DIR" \
  ARK_BASE_URL="http://127.0.0.1:$PORT" \
  omp -p --no-session --no-lsp --no-skills --no-rules --no-context-files \
  -e "$REPO/src/index.ts" --model "arkcli/$MODEL" --thinking max \
  "Read the text in this image. Reply with only that text. @$IMAGE")"

python3 - "$LOG" "$EXPECTED_CODE" "$ANSWER" <<'PY'
import json, sys
log, expected, answer = sys.argv[1], sys.argv[2], sys.argv[3]
bodies = [json.loads(line) for line in open(log, encoding="utf-8") if line.strip()]
chats = [body for body in bodies if "messages" in body]
if not chats:
    sys.exit("no chat request captured")
serialized = json.dumps(chats[-1])
problems = []
if '"image_url"' not in serialized:
    problems.append("request has no image_url part (model registered as text-only?)")
if expected not in answer:
    problems.append(f"answer does not contain {expected!r}: {answer!r}")
if problems:
    sys.exit("vision: " + "; ".join(problems))
print(f"ok  image on the wire and read back as {expected}")
PY

echo "vision assertion passed for arkcli/$MODEL"
