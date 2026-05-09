# llm-proxy

A small JavaScript proxy for logging LLM API requests to SQLite while forwarding them to the real provider.

## Setup

```bash
npm install
npm run dev
```

The server listens on `http://localhost:9999` by default. Override it with `PORT=...`.
If `.env` exists, it is loaded before provider configuration and overrides already-exported shell variables.

## Provider Base URLs

Point each client at the matching provider prefix:

```bash
export ANTHROPIC_BASE_URL=http://localhost:9999/claude
export OPENAI_BASE_URL=http://localhost:9999/openai/v1
export DEEPSEEK_BASE_URL=http://localhost:9999/deepseek
export GEMINI_BASE_URL=http://localhost:9999/gemini
export OPENROUTER_BASE_URL=http://localhost:9999/openrouter/v1
export XAI_BASE_URL=http://localhost:9999/xai/v1
```

For OpenAI-compatible SDKs, both forms work:

```bash
http://localhost:9999/openai
http://localhost:9999/openai/v1
```

The proxy normalizes missing version prefixes for providers that expect them, so `/openai/models` and `/openai/v1/models` both forward to OpenAI's `/v1/models`.

## Supported Prefixes

- `/claude` and `/anthropic` -> `https://api.anthropic.com/v1/...`
- `/openai` -> `https://api.openai.com/v1/...`
- `/deepseek` -> `https://api.deepseek.com/...`
- `/gemini` and `/google` -> `https://generativelanguage.googleapis.com/v1beta/...`
- `/openrouter` -> `https://openrouter.ai/api/v1/...`
- `/xai` and `/grok` -> `https://api.x.ai/v1/...`

Provider API keys are forwarded from the usual environment variables when set. If a client also sends auth, the proxy uses the provider env key for upstream requests and stores the client auth redacted in the request log:

```bash
ANTHROPIC_API_KEY
OPENAI_API_KEY
DEEPSEEK_API_KEY
GEMINI_API_KEY
OPENROUTER_API_KEY
XAI_API_KEY
```

Override upstream URLs with `LLM_PROXY_<PROVIDER>_BASE_URL`, for example:

```bash
export LLM_PROXY_OPENAI_BASE_URL=https://api.openai.com
```

## Local Endpoints

- `GET /health` - health check
- `GET /providers` - configured provider prefixes and upstreams
- `GET /api/requests` - paginated request log
- `GET /api/requests/:id` - one logged request
- `GET /api/requests/:id/websocket-frames` - paginated WebSocket frame log for upgraded requests

Open `http://localhost:9999` for the request explorer.

WebSocket upgrades are logged as one row in `requests`, with each decoded frame stored separately in `websocket_frames`. Request search includes WebSocket frame payloads and returns short matching snippets instead of embedding the full frame stream in the parent row.

For a provider-by-provider endpoint map, see [Provider Endpoint Coverage](docs/provider-endpoints.md).

## Tests

```bash
npm test
```

The test suite starts the proxy on an ephemeral local port and hits real provider API discovery endpoints through the proxy. Providers without the required key are skipped. Providers with invalid keys fail with the real provider response.
