# llm-proxy

A local JavaScript proxy that sits in front of every LLM provider you use, logs each request to SQLite, and gates outbound/inbound traffic on regex policies that you can approve out-of-band — by Touch ID, voice, or anything you wire in.

You point your SDK at `http://localhost:9999/<provider>` instead of the real upstream. The proxy logs the call, forwards it transparently, and — if a policy regex matches — pauses to ask a human before letting the bytes through.

## Why

- **See everything** your tools (Claude Code, Cursor, scripts, agents) actually send. One pane of glass, one SQLite database, full request/response/WebSocket-frame history.
- **Stop the obvious mistakes** before they ship — leaked API keys in prompts, destructive shell-tool calls, anything else you can describe with a regex.
- **Confirm risky actions with your face, your voice, or anything in between.** Plug in a hook, get a synchronous yes/no on every match.

## Quick start

```bash
npm install
npm run build:touchid   # macOS only, for the Touch ID approver
npm run dev:hooks       # starts the policy hook server on :8888
npm run dev             # starts the proxy on :9999
```

Then point your client at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://localhost:9999/claude
export OPENAI_BASE_URL=http://localhost:9999/openai/v1
export DEEPSEEK_BASE_URL=http://localhost:9999/deepseek
export GEMINI_BASE_URL=http://localhost:9999/gemini
export OPENROUTER_BASE_URL=http://localhost:9999/openrouter/v1
export XAI_BASE_URL=http://localhost:9999/xai/v1
```

Open `http://localhost:9999` for the request explorer.

## Provider routing

| Prefix | Upstream |
| --- | --- |
| `/claude`, `/anthropic` | `https://api.anthropic.com/v1/...` |
| `/openai` | `https://api.openai.com/v1/...` |
| `/deepseek` | `https://api.deepseek.com/...` |
| `/gemini`, `/google` | `https://generativelanguage.googleapis.com/v1beta/...` |
| `/openrouter` | `https://openrouter.ai/api/v1/...` |
| `/xai`, `/grok` | `https://api.x.ai/v1/...` |

For OpenAI-compatible SDKs both `http://localhost:9999/openai` and `http://localhost:9999/openai/v1` work — the proxy normalizes missing version prefixes per provider.

Provider keys are forwarded from the usual env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`). If the client also sends auth, the proxy uses the env key for upstream and stores the client auth redacted. Override an upstream with `LLM_PROXY_<PROVIDER>_BASE_URL`.

If `.env` exists in the working directory, it's loaded before provider configuration and overrides already-exported shell variables.

For a per-endpoint table, see [Provider Endpoint Coverage](docs/provider-endpoints.md).

## Local endpoints

- `GET /health` — health check
- `GET /providers` — configured provider prefixes and upstreams
- `GET /api/requests` — paginated request log
- `GET /api/requests/:id` — one logged request
- `GET /api/requests/:id/websocket-frames` — paginated frame log for upgraded requests

WebSocket upgrades are logged as one row in `requests` with each decoded frame stored separately in `websocket_frames`. Request search includes frame payloads and returns short matching snippets instead of embedding the full stream in the parent row.

## Policy hooks

The interesting part. Edit `policies.toml`:

```toml
approver = "voice"   # which hook approver to use (overridable via HOOK_APPROVER env)

[[outbound]]
name = "outbound-credential-leak"
pattern = '''[A-Z][A-Z0-9_]*_KEY\s*=\s*["']?[^"'\s]{12,}'''
flags = "i"
hook_url = "http://127.0.0.1:8888/hooks/policy"

[[inbound]]
name = "inbound-risky-shell-command"
pattern = '''\brm\s+'''
flags = "i"
hook_url = "http://127.0.0.1:8888/hooks/policy"
```

Each rule has a regex `pattern` (PCRE-ish via JS `RegExp`) and a `hook_url`. When a request body, response body, or WebSocket frame matches, the proxy POSTs:

```json
{ "rule": { "name": "...", "pattern": "...", "flags": "..." },
  "text": "<surrounding payload>",
  "offending_text": "<exact substring that matched>" }
```

…and waits for a JSON response. The hook must return:

- `200 { "allow": true }` — forward the original payload as-is
- `403 { "allow": false, "redaction": "[REDACTED]", "comments": "..." }` — substitute and forward (or block)

Default hook URL is `http://127.0.0.1:8888/hooks/policy`. Override globally with `LLM_PROXY_POLICY_HOOK_URL`, or per rule via `hook_url`. The proxy waits up to `LLM_PROXY_POLICY_HOOK_TIMEOUT_MS` milliseconds (default 60000).

Decisions are cached per `(rule, offending_text)` for `HOOK_DECISION_CACHE_TTL_MS` (default 1 hour) so the same secret isn't re-prompted on every retry. All decisions are appended to `user_decisions.jsonl`.

## Approvers

The included hook server (`hook-server.js`) ships with five interchangeable approvers. Pick one in `policies.toml` (`approver = "..."`) or override at runtime with `HOOK_APPROVER=...`.

| Mode | What it does | Requires |
| --- | --- | --- |
| `deny` | Always denies, returns the redaction. Default. | — |
| `approve` | Always allows. Useful for development. | — |
| `touchid` | Pops a macOS Touch ID prompt with the matched rule + snippet. | macOS, `npm run build:touchid` |
| `voice` | Speaks the prompt and listens for "approve" / "deny" via Gemini Live (multimodal native audio). | `GEMINI_API_KEY`, `sox` |
| `local_voice` | Same flow but fully local — surfacing prompt via [LM Studio](https://lmstudio.ai) (default model `google/gemma-4-26b-a4b`), TTS+STT via ElevenLabs. | LM Studio running on `:1234`, `ELEVENLABS_API_KEY`, `sox` |

Switch approvers without restarting? Update `policies.toml` and bounce the hook server (`pm2 restart llm-proxy-hooks --update-env` if you're running under PM2). The proxy itself doesn't restart — it only talks to the hook server.

### Voice approver knobs

Both voice approvers share recorder settings:

- `VOICE_INPUT_RATE` (default `16000`) — mic sample rate
- `ELEVENLABS_RECORD_MAX_MS` (default `30000`) — hard ceiling on user reply length
- `ELEVENLABS_RECORD_PRE_SPEECH_MS` (default `8000`) — give-up timeout before user starts speaking
- `ELEVENLABS_RECORD_SILENCE_MS` (default `1500`) — trailing silence that ends the recording
- `ELEVENLABS_RECORD_SILENCE_THRESHOLD` (default `0.015`) — RMS below this is silence
- `VOICE_CONTEXT_CHARS` (default `4000`) — how much surrounding payload to feed the model

`local_voice` additionally honors `LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL`, `ELEVENLABS_BASE_URL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_TTS_MODEL`, and `ELEVENLABS_STT_MODEL`.

`voice` honors `GEMINI_LIVE_MODEL`, `VOICE_SETUP_TIMEOUT_MS`, `VOICE_SPEAK_TIMEOUT_MS`, and `VOICE_REPLY_TIMEOUT_MS`. When the model forgets to speak the confirmation, it falls back to macOS `say "approved" | "denied"`.

### Writing your own approver

The hook contract is just HTTP — you can replace `hook-server.js` with anything that POSTs back the right JSON. Inside the included server, an approver is a function `(event) => { allow, redaction?, reason?, comments? }`. Add a `case` to the dispatcher in `hook-server.js`'s `approve()` and you're done.

## Tests

```bash
npm test
```

Starts the proxy on an ephemeral port and hits real provider discovery endpoints. Providers without keys are skipped; providers with invalid keys fail with the real provider response.

## Repo layout

```
server.js                    proxy + request logger + UI
hook-server.js               policy hook receiver (dispatches to an approver)
voice-approver.js            Gemini Live voice approver
local-voice-approver.js      LM Studio + ElevenLabs voice approver
touchid-trigger/             Go-based macOS Touch ID prompt
policies.toml                regex rules + approver mode
clean_decisions.js           prune cached decisions
docs/provider-endpoints.md   per-provider endpoint coverage
```
