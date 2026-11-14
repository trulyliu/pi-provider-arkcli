#!/usr/bin/env python3
"""Log-and-forward proxy in front of ARK, for wire-level assertions.

omp only proves what it sends by having a body to look at. Point the provider at
this proxy (`ARK_BASE_URL=http://127.0.0.1:<port>`) and every request body is
appended to the log as one JSON object per line.

    CAPTURE_PORT=18880 CAPTURE_LOG=/tmp/ark-wire.jsonl python3 scripts/capture-proxy.py
"""

import http.server
import json
import os
import urllib.error
import urllib.request

UPSTREAM = os.environ.get("CAPTURE_UPSTREAM", "https://ark.cn-beijing.volces.com/api/v3")
PORT = int(os.environ.get("CAPTURE_PORT", "18880"))
LOG = os.environ.get("CAPTURE_LOG", "/tmp/ark-wire.jsonl")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in ("host", "content-length", "accept-encoding")
        }
        if body:
            with open(LOG, "a", encoding="utf-8") as handle:
                handle.write(body.decode("utf-8", "replace") + "\n")
        request = urllib.request.Request(
            UPSTREAM + self.path, data=body, headers=headers, method=self.command
        )
        try:
            response = urllib.request.urlopen(request, timeout=1800)
            status, payload = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, payload = error.code, error.read()
        except Exception as error:  # noqa: BLE001 - surface any transport failure to the client
            status = 599
            payload = json.dumps({"error": {"message": str(error)}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = forward
    do_POST = forward

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"capturing {UPSTREAM} on 127.0.0.1:{PORT} -> {LOG}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
