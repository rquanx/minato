"""Run against the isolated Compose fixture from inside the fixture container."""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4


PROXY = "http://proxy:4000"
FIXTURE = "http://fixture:18765"


def call(base, path, payload=None, *, call_id=None, stream=False):
    headers = {"Content-Type": "application/json"}
    if base == PROXY:
        headers.update({"Authorization": "Bearer sk-minato-fixture", "X-OpenCode-Session": "fixture-session"})
    if call_id:
        headers["X-LiteLLM-Call-Id"] = call_id
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(base + path, data=data, headers=headers)
    try:
        response = urlopen(request, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        body = response.read().decode()
        if not stream or response.status != 200:
            body = json.loads(body)
        return response.status, response.headers, body


def ready():
    deadline = time.monotonic() + 75
    while time.monotonic() < deadline:
        try:
            if call(PROXY, "/health/liveliness")[0] == 200:
                return
        except URLError:
            pass
        time.sleep(0.5)
    raise RuntimeError("LiteLLM did not become ready")


def set_mode(mode):
    assert call(FIXTURE, "/fixture/mode", {"primary": mode})[0] == 200


def calls():
    return call(FIXTURE, "/fixture/calls")[2]


def respond(model="route-v1", text="classify fixture", *, stream=False, call_id=None, **options):
    payload = {"model": model, "input": text, "text": {"format": {"type": "json_object"}}, **options}
    if stream:
        payload["stream"] = True
    return call(PROXY, "/v1/responses", payload, call_id=call_id, stream=stream)


def register(name, model, path, endpoint):
    status, _, body = call(PROXY, "/model/new", {
        "model_name": name,
        "model_info": {"id": name, "supported_endpoints": [endpoint]},
        "litellm_params": {"model": model, "api_base": FIXTURE + path, "api_key": "fixture-only"},
    })
    assert status == 200, f"model creation returned {status}"
    assert body["model_name"] == name


def check_protocols():
    set_mode("ok")
    status, _, body = respond()
    assert status == 200 and body["usage"]["total_tokens"] == 10
    primary, = calls()
    assert primary["path"] == "/primary/v1/responses" and primary["model"] == "Model A"
    print("PASS native Responses preserves the upstream model ID and usage", flush=True)

    set_mode("rate_limit")
    trace = str(uuid4())
    status, headers, body = respond(call_id=trace)
    assert status == 200 and body["usage"]["total_tokens"] == 12
    assert headers["x-litellm-call-id"] == trace
    _, backup = calls()
    assert backup["path"] == "/backup/v1/chat/completions"
    assert backup["session"] == "fixture-session" and backup["format"]["type"] == "json_object"
    assert json.loads(body["output"][0]["content"][0]["text"])["category"] == "incident"
    print(f"PASS fallback preserves JSON, session and usage; trace {trace}", flush=True)

    set_mode("rate_limit")
    status, _, sse = respond(stream=True)
    assert status == 200
    events = [json.loads(line[6:]) for line in sse.splitlines() if line.startswith("data: {")]
    completed, = [event for event in events if event["type"] == "response.completed"]
    assert completed["response"]["usage"]["total_tokens"] == 12 and "incident" in sse
    print("PASS streaming fallback preserves completion and usage", flush=True)

    set_mode("invalid_request")
    assert respond()[0] == 200 and len(calls()) == 2
    set_mode("invalid_request")
    assert respond(disable_fallbacks=True)[0] == 400 and len(calls()) == 1
    print("PASS explicit fallback suppression preserves the upstream 400", flush=True)

    set_mode("rate_limit")
    first_status, _, _ = respond(disable_fallbacks=True)
    assert first_status == 429 and len(calls()) == 1
    status, _, body = respond("backup-v1", disable_fallbacks=True)
    assert status == 200 and body["usage"]["total_tokens"] == 12
    assert [entry["model"] for entry in calls()] == ["Model A", "model-b"]
    print("PASS a separate backup attempt preserves the Responses contract", flush=True)


def check_publish():
    suffix = uuid4().hex[:8]
    route = f"route-v2-{suffix}"
    backup = f"backup-v2-{suffix}"
    set_mode("rate_limit")
    with ThreadPoolExecutor(max_workers=1) as pool:
        in_flight = pool.submit(respond, text="delayed fixture")
        deadline = time.monotonic() + 2
        while not calls():
            assert time.monotonic() < deadline, "Old request never reached the primary fixture"
            time.sleep(0.03)
        register(route, "openai/Model A", "/primary/v1", "/v1/responses")
        register(backup, "openai/chat_completions/model-c", "/backup/v1", "/v1/chat/completions")
        settings = {"router_settings": {"fallbacks": [{"route-v1": ["backup-v1"]}, {route: [backup]}]}}
        assert call(PROXY, "/config/update", settings)[0] == 200
        assert respond(route, text="new fixture")[0] == 200
        assert in_flight.result()[0] == 200
    seen = {entry["input"][0]["content"]: entry["model"] for entry in calls()
            if entry["path"] == "/backup/v1/chat/completions"}
    assert seen == {"delayed fixture": "model-b", "new fixture": "model-c"}, seen
    print("PASS dynamic v2 publication preserves the in-flight v1 fallback", flush=True)
    set_mode("rate_limit")
    assert respond()[0] == 200 and calls()[-1]["model"] == "model-b"
    print("PASS the previous route remains callable for rollback", flush=True)


if __name__ == "__main__":
    ready()
    check_protocols()
    check_publish()
