import asyncio
import json
import os
from urllib.request import Request, urlopen
from uuid import UUID

from litellm.integrations.custom_logger import CustomLogger


class MinatoCallbacks(CustomLogger):
    async def send_usage(self, kwargs, response):
        attempt = kwargs.get("litellm_call_id")
        secret = os.getenv("MINATO_CALLBACK_SECRET")
        usage = getattr(response, "usage", None)
        if not attempt or not secret or usage is None:
            return
        try:
            UUID(attempt)
        except ValueError:
            return
        if hasattr(usage, "model_dump"):
            usage = usage.model_dump(exclude_none=True)
        if not isinstance(usage, dict):
            return
        payload = json.dumps({"attemptId": attempt, "usage": usage}).encode()
        request = Request(
            os.getenv("MINATO_CALLBACK_URL", "http://minato:4101/internal/v1/litellm/usage"),
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
        )

        def deliver():
            with urlopen(request, timeout=3) as incoming:
                return incoming.status

        for delay in (0, 0.25, 1):
            if delay:
                await asyncio.sleep(delay)
            try:
                if await asyncio.to_thread(deliver) == 204:
                    return
            except OSError:
                continue
        print("Minato usage callback delivery failed", flush=True)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        await self.send_usage(kwargs, response_obj)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        await self.send_usage(kwargs, response_obj)


logger = MinatoCallbacks()
