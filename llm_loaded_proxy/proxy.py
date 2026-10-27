"""OpenAI-compatible proxy in front of a llama.cpp router that sends every request to the
model the router already has loaded.

A llama.cpp router (llama-server in router mode) loads whatever model a request names. Clients
that can't follow a model switch (Frigate's GenAI config names one model) then drag a big model
in while the PC is busy. This proxy asks the router's /v1/models which model is loaded and puts
that name in the request's "model" field before forwarding it. Everything else (headers, the
API key, streaming responses) passes straight through. The proxy stores no credentials: it uses
the caller's own Authorization header for its /v1/models lookup.

If nothing is loaded (a model swap is in progress), it waits up to wait_seconds for a model to
finish loading. If none does, it uses fallback_model when one is set, else answers 503 so the
caller skips that request instead of loading a model.

GET /healthz (no auth) reports the upstream and the last model seen loaded.
"""

import asyncio
import json
import logging
import os
import time

from aiohttp import ClientSession, ClientTimeout, web

OPTIONS_FILE = os.environ.get("OPTIONS_FILE", "/data/options.json")
DEFAULTS = {
    "upstream": "http://10.0.1.161:8080",
    "listen_port": 8080,
    "wait_seconds": 30,
    "cache_seconds": 5,
    "fallback_model": "",
    "log_requests": True,
}
# Hop-by-hop and length/encoding headers: aiohttp recomputes or decodes these itself.
SKIP_REQUEST_HEADERS = {"host", "content-length", "transfer-encoding", "connection", "accept-encoding"}
SKIP_RESPONSE_HEADERS = {"content-length", "transfer-encoding", "connection", "content-encoding", "keep-alive"}

log = logging.getLogger("llm_loaded_proxy")


def load_options():
    opts = dict(DEFAULTS)
    try:
        with open(OPTIONS_FILE) as f:
            opts.update({k: v for k, v in json.load(f).items() if v is not None})
    except FileNotFoundError:
        log.warning("no %s, using defaults", OPTIONS_FILE)
    opts["upstream"] = opts["upstream"].rstrip("/")
    return opts


class Proxy:
    def __init__(self, opts):
        self.opts = opts
        self.session = None
        self._cache = (0.0, None)   # (monotonic time, loaded model or None)
        self.last_loaded = None
        self.last_rewrite = None

    async def start(self, app):
        # No total timeout: a request can sit behind a model load for minutes.
        self.session = ClientSession(timeout=ClientTimeout(total=None, sock_connect=10, sock_read=900),
                                     auto_decompress=True)

    async def stop(self, app):
        await self.session.close()

    async def statuses(self, auth):
        headers = {"Authorization": auth} if auth else {}
        async with self.session.get(self.opts["upstream"] + "/v1/models", headers=headers,
                                    timeout=ClientTimeout(total=10)) as r:
            r.raise_for_status()
            data = await r.json(content_type=None)
        return {m.get("id"): ((m.get("status") or {}).get("value") or "") for m in data.get("data", [])}

    async def loaded_model(self, auth):
        """The model the router has loaded, waiting through a swap; None if nothing loads in time."""
        at, model = self._cache
        if model and time.monotonic() - at < self.opts["cache_seconds"]:
            return model
        deadline = time.monotonic() + self.opts["wait_seconds"]
        while True:
            st = await self.statuses(auth)
            loaded = [k for k, v in st.items() if v == "loaded"]
            if loaded:
                self._cache = (time.monotonic(), loaded[0])
                self.last_loaded = loaded[0]
                return loaded[0]
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(2)

    async def healthz(self, request):
        return web.json_response({"upstream": self.opts["upstream"], "last_loaded": self.last_loaded,
                                  "last_rewrite": self.last_rewrite})

    async def handle(self, request):
        body = await request.read()
        headers = {k: v for k, v in request.headers.items() if k.lower() not in SKIP_REQUEST_HEADERS}
        note = ""

        if request.method == "POST" and body:
            try:
                payload = json.loads(body)
            except ValueError:
                payload = None
            if isinstance(payload, dict):
                asked = payload.get("model")
                try:
                    model = await self.loaded_model(request.headers.get("Authorization"))
                except Exception as e:  # router down or rejecting the key
                    log.warning("could not read %s/v1/models: %s", self.opts["upstream"], e)
                    return web.json_response({"error": {"message": f"llm_loaded_proxy: router status unavailable: {e}",
                                                        "type": "unavailable"}}, status=502)
                if model is None:
                    model = self.opts["fallback_model"] or None
                    if model is None:
                        log.info("%s %s: no model loaded after %s s, refusing (asked for %r)",
                                 request.method, request.path, self.opts["wait_seconds"], asked)
                        return web.json_response({"error": {"message": "llm_loaded_proxy: no model loaded",
                                                            "type": "unavailable"}}, status=503)
                    note = " (fallback)"
                payload["model"] = model
                body = json.dumps(payload).encode()
                headers["Content-Type"] = "application/json"
                self.last_rewrite = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "path": request.path,
                                     "asked": asked, "sent": model}
                if self.opts["log_requests"]:
                    log.info("%s %s: model %r -> %r%s", request.method, request.path, asked, model, note)

        url = self.opts["upstream"] + request.rel_url.path_qs
        async with self.session.request(request.method, url, headers=headers, data=body or None) as up:
            resp = web.StreamResponse(status=up.status, reason=up.reason)
            for k, v in up.headers.items():
                if k.lower() not in SKIP_RESPONSE_HEADERS:
                    resp.headers[k] = v
            await resp.prepare(request)
            async for chunk in up.content.iter_any():
                await resp.write(chunk)
            await resp.write_eof()
            return resp


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    opts = load_options()
    proxy = Proxy(opts)
    app = web.Application(client_max_size=64 * 1024 * 1024)   # base64 images
    app.on_startup.append(proxy.start)
    app.on_cleanup.append(proxy.stop)
    app.router.add_get("/healthz", proxy.healthz)
    app.router.add_route("*", "/{tail:.*}", proxy.handle)
    log.info("forwarding to %s, port %s, wait %s s, fallback %r", opts["upstream"], opts["listen_port"],
             opts["wait_seconds"], opts["fallback_model"])
    web.run_app(app, port=int(opts["listen_port"]), access_log=None, print=None)


if __name__ == "__main__":
    main()
