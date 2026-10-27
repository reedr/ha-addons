# LLM Loaded-Model Proxy

An OpenAI-compatible proxy for a [llama.cpp](https://github.com/ggml-org/llama.cpp) router (llama-server in router mode). It sends every request to whatever model the router already has loaded.

The router loads whichever model a request names. A client that names one fixed model, such as Frigate's GenAI config, therefore pulls that model in even while you've swapped to a smaller one on purpose. This proxy:

1. reads the router's `GET /v1/models` and picks the model whose status is `loaded`;
2. replaces the `model` field of each JSON `POST` (chat completions and similar) with that name;
3. forwards the request unchanged otherwise (headers, API key, query string), and streams the response back.

It stores no credentials. The `/v1/models` lookup reuses the caller's own `Authorization` header.

## Swaps and failures

| Situation | Result |
|---|---|
| A model is loaded | Request goes to that model |
| Nothing loaded yet (swap in progress) | Waits up to `wait_seconds` for one to finish loading |
| Still nothing after `wait_seconds` | Uses `fallback_model` if set, else **503** (the caller skips; no model is loaded) |
| Router unreachable, or it rejects the key | **502** |

## Options

| Option | Default | Meaning |
|---|---|---|
| `upstream` | `http://10.0.1.161:8080` | The llama.cpp router |
| `wait_seconds` | 30 | How long to wait for a model during a swap |
| `cache_seconds` | 5 | How long to reuse a `/v1/models` answer |
| `fallback_model` | empty | Model to name when nothing loads in time (empty = answer 503) |
| `log_requests` | true | Log each rewrite (`model 'gemma' -> 'gemma-12b'`) |

## Use from another add-on (Frigate)

Other add-ons reach it by its add-on hostname on port 8080, shown on the add-on's Info page (`<repo-id>-llm-loaded-proxy`). For Frigate:

```yaml
genai:
  default:
    provider: openai
    base_url: http://<repo-id>-llm-loaded-proxy:8080
    api_key: <your router key>
    model: loaded        # any name; the proxy replaces it
```

The host port (8080/tcp) is off by default. Turn it on in the add-on's Network settings only if something outside the add-on network needs it.

`GET /healthz` (no auth) reports the upstream, the last model seen loaded and the last rewrite.
