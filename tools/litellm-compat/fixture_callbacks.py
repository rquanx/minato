import json

from litellm.integrations.custom_logger import CustomLogger


class FixtureLogger(CustomLogger):
    def log_attempt(self, kwargs, response, result):
        params = kwargs.get("litellm_params") or {}
        metadata = params.get("metadata") or {}
        standard = kwargs.get("standard_logging_object") or {}
        usage = getattr(response, "usage", None)
        print("FIXTURE_EVENT " + json.dumps({
            "result": result,
            "model": kwargs.get("model"),
            "call_id": kwargs.get("litellm_call_id"),
            "proxy_request_id": metadata.get("litellm_trace_id"),
            "standard_trace_id": standard.get("trace_id"),
            "client_id": (metadata.get("headers") or {}).get("x-minato-request-id"),
            "total_tokens": getattr(usage, "total_tokens", None),
        }), flush=True)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self.log_attempt(kwargs, response_obj, "success")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self.log_attempt(kwargs, response_obj, "failure")


logger = FixtureLogger()
