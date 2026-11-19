"""Synthetic OpenAI-compatible upstreams for the LiteLLM compatibility check."""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock


TEXT = '{"category":"incident"}'
PRIMARY = "/primary/v1/responses"
BACKUP = "/backup/v1/chat/completions"


class MockServer(ThreadingHTTPServer):
    def __init__(self, address):
        super().__init__(address, Handler)
        self.lock = Lock()
        self.mode = "ok"
        self.calls = []


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/primary/v1/models", "/backup/v1/models"):
            ids = ["Model A"] if self.path.startswith("/primary") else ["model-b", "model-c"]
            self.send_json(200, {"object": "list", "data": [{"id": item} for item in ids]})
        elif self.path == "/fixture/calls":
            with self.server.lock:
                calls = list(self.server.calls)
            self.send_json(200, calls)
        else:
            self.send_json(404, {"error": "Unknown fixture path"})

    def do_POST(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024 * 1024:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError("Expected a JSON object")
        except ValueError:
            self.send_json(400, {"error": {"message": "Invalid fixture request"}})
            return

        if self.path == "/fixture/mode":
            mode = payload.get("primary")
            if mode not in ("ok", "rate_limit", "invalid_request", "stream_partial"):
                self.send_json(400, {"error": "Unknown fixture mode"})
                return
            with self.server.lock:
                self.server.mode = mode
                self.server.calls.clear()
            self.send_json(200, {"primary": mode})
            return

        if self.path not in (PRIMARY, BACKUP):
            self.send_json(404, {"error": "Unexpected upstream endpoint"})
            return

        with self.server.lock:
            mode = self.server.mode
            self.server.calls.append({
                "path": self.path,
                "model": payload.get("model"),
                "session": self.headers.get("x-opencode-session"),
                "input": payload.get("input", payload.get("messages")),
                "format": payload.get("text", payload.get("response_format")),
            })

        if self.path == PRIMARY and payload.get("input") == "delayed fixture":
            time.sleep(3)

        if self.path == PRIMARY and mode == "stream_partial":
            frame = {"type": "response.output_text.delta", "delta": "partial synthetic output", "output_index": 0,
                     "content_index": 0, "item_id": "msg_fixture", "sequence_number": 0}
            body = f"event: {frame['type']}\ndata: {json.dumps(frame)}\n\n".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == PRIMARY and mode != "ok":
            status = 429 if mode == "rate_limit" else 400
            error_type = "rate_limit_error" if status == 429 else "invalid_request_error"
            self.send_json(status, {"error": {"message": mode, "type": error_type}})
            return

        if payload.get("stream") and self.path == BACKUP:
            self.send_chat_stream(payload.get("model"))
            return
        if payload.get("stream"):
            self.send_json(400, {"error": {"message": "This fixture covers JSON responses"}})
            return

        model = payload.get("model")
        if self.path == PRIMARY:
            self.send_json(200, {
                "id": "resp_fixture", "object": "response", "created_at": int(time.time()),
                "status": "completed", "model": model,
                "output": [{
                    "id": "msg_fixture", "type": "message", "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": TEXT, "annotations": []}],
                }],
                "usage": {"input_tokens": 7, "output_tokens": 3, "total_tokens": 10},
            })
        else:
            self.send_json(200, {
                "id": "chatcmpl_fixture", "object": "chat.completion",
                "created": int(time.time()), "model": model,
                "choices": [{
                    "index": 0, "message": {"role": "assistant", "content": TEXT},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12},
            })

    def send_chat_stream(self, model):
        base = {"id": "chatcmpl_fixture", "object": "chat.completion.chunk",
                "created": int(time.time()), "model": model}
        frames = [
            {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": TEXT},
                                  "finish_reason": None}]},
            {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            {**base, "choices": [], "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12}},
        ]
        body = ("".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18765)
    args = parser.parse_args()
    with MockServer((args.host, args.port)) as server:
        print(f"Fixture listening at http://{args.host}:{args.port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
