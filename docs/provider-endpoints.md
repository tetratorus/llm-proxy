# Provider Endpoint Coverage

This document maps official provider endpoint surfaces to `llm-proxy` prefixes. The proxy forwards all HTTP methods under a provider prefix unless the path is one of the local proxy endpoints (`/health`, `/providers`, `/api/requests`, `/api/requests/:id`).

Sources were checked on 2026-05-09. For providers with machine-readable specs, the endpoint list below is derived from those specs.

## Mapping Rules

| Provider | Local base URL | Upstream base URL | Version handling |
| --- | --- | --- | --- |
| Claude / Anthropic | `http://localhost:9999/claude` | `https://api.anthropic.com` | Adds `/v1` when omitted. |
| OpenAI | `http://localhost:9999/openai` | `https://api.openai.com` | Adds `/v1` when omitted. |
| DeepSeek | `http://localhost:9999/deepseek` | `https://api.deepseek.com` | No version prefix is added. |
| Gemini | `http://localhost:9999/gemini` | `https://generativelanguage.googleapis.com` | Adds `/v1beta` when omitted, except `/upload/...` paths. |
| OpenRouter | `http://localhost:9999/openrouter` | `https://openrouter.ai/api` | Adds `/v1` when omitted. |
| xAI | `http://localhost:9999/xai` | `https://api.x.ai` | Adds `/v1` when omitted. |

Example: `GET /openai/models` and `GET /openai/v1/models` both forward to `GET https://api.openai.com/v1/models`.

## Claude / Anthropic

Auth/header behavior:
- Injects `x-api-key: $ANTHROPIC_API_KEY` when the client did not send one.
- Adds `anthropic-version: 2023-06-01` when omitted.
- Forwards Anthropic beta headers and streaming responses.

Core endpoints:

| Official endpoint | Proxy forms |
| --- | --- |
| `POST /v1/messages` | `/claude/messages`, `/claude/v1/messages` |
| `POST /v1/messages/count_tokens` | `/claude/messages/count_tokens`, `/claude/v1/messages/count_tokens` |
| `GET /v1/models` | `/claude/models`, `/claude/v1/models` |
| `GET /v1/models/{model_id}` | `/claude/models/{model_id}`, `/claude/v1/models/{model_id}` |
| `POST /v1/messages/batches` | `/claude/messages/batches`, `/claude/v1/messages/batches` |
| `GET /v1/messages/batches` | `/claude/messages/batches`, `/claude/v1/messages/batches` |
| `GET /v1/messages/batches/{message_batch_id}` | `/claude/messages/batches/{id}`, `/claude/v1/messages/batches/{id}` |
| `POST /v1/messages/batches/{message_batch_id}/cancel` | `/claude/messages/batches/{id}/cancel`, `/claude/v1/messages/batches/{id}/cancel` |
| `GET /v1/messages/batches/{message_batch_id}/results` | `/claude/messages/batches/{id}/results`, `/claude/v1/messages/batches/{id}/results` |
| `POST /v1/files` | `/claude/files`, `/claude/v1/files` |
| `GET /v1/files` | `/claude/files`, `/claude/v1/files` |
| `GET /v1/files/{file_id}` | `/claude/files/{file_id}`, `/claude/v1/files/{file_id}` |
| `GET /v1/files/{file_id}/content` | `/claude/files/{file_id}/content`, `/claude/v1/files/{file_id}/content` |
| `DELETE /v1/files/{file_id}` | `/claude/files/{file_id}`, `/claude/v1/files/{file_id}` |

Other Anthropic API families, including Admin, Compliance, Usage/Cost, Workspaces, and beta Managed Agents, are also path-forwarded when called under `/claude/...`; access depends on account permissions and required beta headers.

Sources: Anthropic API reference index in `https://docs.anthropic.com/llms.txt`, Messages API, Models API, Files API, Message Batches API.

## OpenAI

Auth/header behavior:
- Forwards `Authorization: Bearer $OPENAI_API_KEY` when set, overriding any incoming client auth for upstream OpenAI requests.
- Supports JSON, streaming, multipart/file bodies, and WebSocket upgrades.

OpenAI’s API reference describes REST, streaming, and realtime APIs. The proxy does normal HTTP forwarding for these endpoint families:

| Endpoint family | Official paths | Proxy forms |
| --- | --- | --- |
| Responses | `/v1/responses`, `/v1/responses/{response_id}`, related response item paths | `/openai/responses...`, `/openai/v1/responses...` |
| Chat Completions | `/v1/chat/completions`, `/v1/chat/completions/{completion_id}`, `/v1/chat/completions/{completion_id}/messages` | `/openai/chat/completions...`, `/openai/v1/chat/completions...` |
| Completions | `/v1/completions` | `/openai/completions`, `/openai/v1/completions` |
| Models | `/v1/models`, `/v1/models/{model}` | `/openai/models...`, `/openai/v1/models...` |
| Embeddings | `/v1/embeddings` | `/openai/embeddings`, `/openai/v1/embeddings` |
| Images | `/v1/images/generations`, `/v1/images/edits`, `/v1/images/variations` | `/openai/images/...`, `/openai/v1/images/...` |
| Audio | `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations` | `/openai/audio/...`, `/openai/v1/audio/...` |
| Files | `/v1/files`, `/v1/files/{file_id}`, `/v1/files/{file_id}/content` | `/openai/files...`, `/openai/v1/files...` |
| Uploads | `/v1/uploads`, `/v1/uploads/{upload_id}`, `/v1/uploads/{upload_id}/parts`, `/v1/uploads/{upload_id}/complete`, `/v1/uploads/{upload_id}/cancel` | `/openai/uploads...`, `/openai/v1/uploads...` |
| Batches | `/v1/batches`, `/v1/batches/{batch_id}`, `/v1/batches/{batch_id}/cancel` | `/openai/batches...`, `/openai/v1/batches...` |
| Fine-tuning | `/v1/fine_tuning/jobs...`, `/v1/fine_tuning/checkpoints...` | `/openai/fine_tuning...`, `/openai/v1/fine_tuning...` |
| Vector stores | `/v1/vector_stores...` | `/openai/vector_stores...`, `/openai/v1/vector_stores...` |
| Assistants / Threads | `/v1/assistants...`, `/v1/threads...` | `/openai/assistants...`, `/openai/v1/assistants...` |
| Realtime / Sessions | `/v1/realtime...`, `/v1/realtime/sessions`, `/v1/realtime/transcription_sessions` | `/openai/realtime...`, `/openai/v1/realtime...` |
| Moderations | `/v1/moderations` | `/openai/moderations`, `/openai/v1/moderations` |
| Usage / Organization | `/v1/organization/...`, `/v1/usage/...` where available to the key | `/openai/organization...`, `/openai/v1/organization...` |

Sources: OpenAI API Reference introduction, Responses, Chat Completions, Batch API, Files, Images, Audio, Models pages.

## DeepSeek

Auth/header behavior:
- Injects `Authorization: Bearer $DEEPSEEK_API_KEY` when the client did not send one.
- DeepSeek’s public API is OpenAI-compatible and uses `https://api.deepseek.com` without `/v1`.

| Official endpoint | Proxy form |
| --- | --- |
| `GET /models` | `/deepseek/models` |
| `POST /chat/completions` | `/deepseek/chat/completions` |
| Beta prefix-completion variants | `/deepseek/beta/...` if `LLM_PROXY_DEEPSEEK_BASE_URL` is set to a beta base or if DeepSeek exposes the path under the configured base. |

DeepSeek documents streaming as SSE for chat completions and returns OpenAI-style chat completion objects. It currently documents model listing and chat completion as the main public endpoints.

Sources: DeepSeek API Docs, “Lists Models” and “Create Chat Completion”.

## Gemini

Auth/header behavior:
- Injects `x-goog-api-key: $GEMINI_API_KEY` when the client did not send one.
- Adds `/v1beta` by default.
- Special-cases `/upload/...` so file upload paths forward to Google’s upload host path rather than `/v1beta/upload/...`.

Model and generation endpoints:

| Official endpoint | Proxy forms |
| --- | --- |
| `GET /v1beta/models` | `/gemini/models`, `/gemini/v1beta/models` |
| `GET /v1beta/models/{model}` | `/gemini/models/{model}`, `/gemini/v1beta/models/{model}` |
| `POST /v1beta/models/{model}:generateContent` | `/gemini/models/{model}:generateContent`, `/gemini/v1beta/models/{model}:generateContent` |
| `POST /v1beta/models/{model}:streamGenerateContent` | `/gemini/models/{model}:streamGenerateContent`, `/gemini/v1beta/models/{model}:streamGenerateContent` |
| `POST /v1beta/models/{model}:countTokens` | `/gemini/models/{model}:countTokens`, `/gemini/v1beta/models/{model}:countTokens` |
| `POST /v1beta/models/{model}:embedContent` | `/gemini/models/{model}:embedContent`, `/gemini/v1beta/models/{model}:embedContent` |
| `POST /v1beta/models/{model}:batchEmbedContents` | `/gemini/models/{model}:batchEmbedContents`, `/gemini/v1beta/models/{model}:batchEmbedContents` |

Files, caches, tuning, permissions, and operations:

| Official endpoint family | Proxy forms |
| --- | --- |
| `POST /upload/v1beta/files` | `/gemini/upload/v1beta/files` |
| `POST /v1beta/files`, `GET /v1beta/files`, `GET/DELETE /v1beta/files/{file}` | `/gemini/files...`, `/gemini/v1beta/files...` |
| `POST/GET /v1beta/cachedContents`, `GET/PATCH/DELETE /v1beta/cachedContents/{id}` | `/gemini/cachedContents...`, `/gemini/v1beta/cachedContents...` |
| `/v1beta/tunedModels...` generation, tuning jobs, permissions, operations | `/gemini/tunedModels...`, `/gemini/v1beta/tunedModels...` |
| `/v1beta/corpora...` permissions where supported | `/gemini/corpora...`, `/gemini/v1beta/corpora...` |
| Long-running operations under `/v1beta/.../operations/...` | `/gemini/.../operations...`, `/gemini/v1beta/.../operations...` |

Sources: Google AI Gemini API reference overview, Files, Caching, Tuning, Permissions.

## OpenRouter

Auth/header behavior:
- Injects `Authorization: Bearer $OPENROUTER_API_KEY` when the client did not send one.
- Adds OpenRouter attribution headers unless overridden by env.
- Adds `/v1` after upstream `/api` when omitted.

OpenRouter publishes an OpenAPI spec. Current documented paths from that spec:

```text
/activity
/audio/speech
/audio/transcriptions
/auth/keys
/auth/keys/code
/chat/completions
/credits
/credits/coinbase
/embeddings
/embeddings/models
/endpoints/zdr
/generation
/generation/content
/guardrails
/guardrails/assignments/keys
/guardrails/assignments/members
/guardrails/{id}
/guardrails/{id}/assignments/keys
/guardrails/{id}/assignments/keys/remove
/guardrails/{id}/assignments/members
/guardrails/{id}/assignments/members/remove
/key
/keys
/keys/{hash}
/messages
/models
/models/count
/models/user
/models/{author}/{slug}/endpoints
/organization/members
/providers
/rerank
/responses
/videos
/videos/models
/videos/{jobId}
/videos/{jobId}/content
/workspaces
/workspaces/{id}
/workspaces/{id}/members/add
/workspaces/{id}/members/remove
```

Proxy examples:
- `/openrouter/chat/completions` -> `https://openrouter.ai/api/v1/chat/completions`
- `/openrouter/models` -> `https://openrouter.ai/api/v1/models`
- `/openrouter/v1/responses` -> `https://openrouter.ai/api/v1/responses`

Sources: OpenRouter API Reference overview and `https://openrouter.ai/openapi.json`.

## xAI

Auth/header behavior:
- Injects `Authorization: Bearer $XAI_API_KEY` when the client did not send one.
- Adds `/v1` when omitted.

xAI publishes an OpenAPI spec at `https://docs.x.ai/openapi.json`. Current paths from that spec:

```text
/v1/api-key
/v1/chat/completions
/v1/chat/deferred-completion/{request_id}
/v1/complete
/v1/completions
/v1/documents/search
/v1/embedding-models
/v1/embedding-models/{model_id}
/v1/embeddings
/v1/files
/v1/files/{file_id}
/v1/files/{file_id}/content
/v1/image-generation-models
/v1/image-generation-models/{model_id}
/v1/images/edits
/v1/images/generations
/v1/language-models
/v1/language-models/{model_id}
/v1/messages
/v1/models
/v1/models/{model_id}
/v1/responses
/v1/responses/{response_id}
/v1/tokenize-text
/v1/video-generation-models
/v1/video-generation-models/{model_id}
/v1/videos/edits
/v1/videos/extensions
/v1/videos/generations
/v1/videos/{request_id}
```

Proxy examples:
- `/xai/chat/completions` -> `https://api.x.ai/v1/chat/completions`
- `/xai/v1/models/{model_id}` -> `https://api.x.ai/v1/models/{model_id}`

Sources: xAI REST API Reference and `https://docs.x.ai/openapi.json`.

## Coverage Notes

- The proxy is not an endpoint allowlist. If a provider adds a new route under the same base/version conventions, it should forward without a code change.
- The code now handles multipart/raw upload bodies for file and media endpoints, but the default size limit is `50mb`.
- Local proxy endpoints are reserved and not forwarded: `/health`, `/providers`, `/api/requests`, `/api/requests/:id`, `/api/requests/:id/history`.
- Some official endpoint families require account permissions, beta headers, organization scopes, or non-API-key OAuth. The proxy forwards the path and headers, but cannot grant provider-side access.
