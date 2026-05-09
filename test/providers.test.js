const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.REQUESTS_DB = path.join(os.tmpdir(), `llm-proxy-test-${process.pid}.db`);
process.env.LLM_PROXY_POLICY_FILE = path.join(os.tmpdir(), `llm-proxy-policy-${process.pid}.json`);

const { buildUpstreamHeaders, loadDotEnv, startServer, PROVIDERS } = require('../server');

const providerTests = [
  {
    name: 'claude',
    requiredEnv: 'ANTHROPIC_API_KEY',
    paths: ['/claude/models', '/claude/v1/models'],
    validate: body => {
      assert.equal(body.data && Array.isArray(body.data), true);
    },
  },
  {
    name: 'openai',
    requiredEnv: 'OPENAI_API_KEY',
    paths: ['/openai/models', '/openai/v1/models'],
    validate: body => {
      assert.equal(body.object, 'list');
      assert.equal(Array.isArray(body.data), true);
    },
  },
  {
    name: 'deepseek',
    requiredEnv: 'DEEPSEEK_API_KEY',
    paths: ['/deepseek/models'],
    validate: body => {
      assert.equal(body.object, 'list');
      assert.equal(Array.isArray(body.data), true);
    },
  },
  {
    name: 'gemini',
    requiredEnv: 'GEMINI_API_KEY',
    paths: ['/gemini/models', '/gemini/v1beta/models'],
    validate: body => {
      assert.equal(Array.isArray(body.models), true);
    },
  },
  {
    name: 'openrouter',
    requiredEnv: 'OPENROUTER_API_KEY',
    paths: ['/openrouter/models', '/openrouter/v1/models'],
    validate: body => {
      assert.equal(Array.isArray(body.data), true);
    },
  },
  {
    name: 'xai',
    requiredEnv: 'XAI_API_KEY',
    paths: ['/xai/models', '/xai/v1/models'],
    validate: body => {
      assert.equal(Array.isArray(body.data), true);
    },
  },
];

let server;
let baseUrl;

test.before(async () => {
  server = startServer(0);
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
});

for (const provider of providerTests) {
  test(`${provider.name} live endpoints`, async t => {
    if (!process.env[provider.requiredEnv]) {
      t.skip(`${provider.requiredEnv} is not set`);
      return;
    }

    for (const providerPath of provider.paths) {
      await t.test(providerPath, async () => {
        const response = await fetch(`${baseUrl}${providerPath}`);
        const text = await response.text();
        const body = parseJson(text, provider.name, providerPath, response.status);

        if (provider.allowUnavailable && response.status === 502 && text.includes('fetch failed')) {
          t.skip(`${provider.name} upstream is not reachable`);
          return;
        }

        assert.ok(
          response.status >= 200 && response.status < 300,
          `${provider.name} ${providerPath} returned HTTP ${response.status}: ${snippet(text)}`
        );
        provider.validate(body);
      });
    }
  });
}

test('logged requests redact incoming auth headers', async () => {
  if (!process.env.OPENAI_API_KEY) return;

  const marker = `redaction-${process.pid}-${Date.now()}`;
  await fetch(`${baseUrl}/openai/models`, {
    headers: {
      authorization: 'Bearer test-redaction-value',
      'x-test-request': marker,
    },
  });
  const response = await fetch(`${baseUrl}/api/requests?limit=200`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const request = body.requests.find(item => item.headers && item.headers['x-test-request'] === marker);
  assert.ok(request, 'expected to find logged redaction test request');
  assert.equal(request.headers.authorization, '[REDACTED]');
});

test('provider env auth overrides incoming client auth', () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'env-openai-key';

  try {
    const headers = buildUpstreamHeaders({
      headers: {
        Authorization: 'Bearer client-key',
        'content-type': 'application/json',
      },
    }, { name: 'openai', config: PROVIDERS.openai });

    assert.equal(headers.authorization, 'Bearer env-openai-key');
    assert.equal(headers.Authorization, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  }
});

test('websocket frames are logged separately and searchable', async () => {
  const previousBase = PROVIDERS.openai.upstreamBase;
  const previousKey = process.env.OPENAI_API_KEY;
  const clientMarker = `client-ws-${process.pid}-${Date.now()}`;
  const serverMarker = `server-ws-${process.pid}-${Date.now()}`;
  let upstreamSawEnvAuth = false;
  let upstreamSawCompression = false;
  const upstreamSockets = new Set();

  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
    upstreamSawEnvAuth = req.headers.authorization === 'Bearer test-env-ws-key';
    upstreamSawCompression = Boolean(req.headers['sec-websocket-extensions']);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write(websocketTextFrame(JSON.stringify({ marker: serverMarker })));
    setTimeout(() => socket.end(), 50);
  });

  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  PROVIDERS.openai.upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  process.env.OPENAI_API_KEY = 'test-env-ws-key';

  try {
    let client;
    await new Promise((resolve, reject) => {
      client = net.connect(new URL(baseUrl).port, '127.0.0.1', () => {
        client.write([
          'GET /openai/realtime?model=test HTTP/1.1',
          `Host: ${new URL(baseUrl).host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
          'Authorization: Bearer client-key',
          '',
          '',
        ].join('\r\n'));
        setTimeout(() => {
          client.write(websocketTextFrame(JSON.stringify({ marker: clientMarker }), true));
        }, 25);
      });
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error('timed out waiting for websocket test client to close'));
      }, 2000);
      setTimeout(() => {
        clearTimeout(timeout);
        client.destroy();
        resolve();
      }, 200);
      client.on('error', reject);
    });

    assert.equal(upstreamSawEnvAuth, true);
    assert.equal(upstreamSawCompression, false);

    const searchResponse = await fetch(`${baseUrl}/api/requests?search=${encodeURIComponent(clientMarker)}&limit=10`);
    assert.equal(searchResponse.status, 200);
    const searchBody = await searchResponse.json();
    assert.equal(searchBody.total, 1);
    assert.equal(searchBody.requests[0].body.websocket, true);
    assert.equal(searchBody.requests[0].websocket_frame_count >= 2, true);
    assert.equal(searchBody.requests[0].websocket_matches.some(match => match.snippet.includes(clientMarker)), true);

    const framesResponse = await fetch(`${baseUrl}/api/requests/${searchBody.requests[0].id}/websocket-frames?limit=10`);
    assert.equal(framesResponse.status, 200);
    const framesBody = await framesResponse.json();
    assert.equal(framesBody.frames.some(frame => frame.direction === 'client' && frame.payload.includes(clientMarker)), true);
    assert.equal(framesBody.frames.some(frame => frame.direction === 'server' && frame.payload.includes(serverMarker)), true);
  } finally {
    PROVIDERS.openai.upstreamBase = previousBase;
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('policy hooks receive outbound and inbound websocket matches with context', async () => {
  const previousBase = PROVIDERS.openai.upstreamBase;
  const previousKey = process.env.OPENAI_API_KEY;
  const outboundMarker = `OUTBOUND_POLICY_${process.pid}_${Date.now()}`;
  const inboundMarker = `INBOUND_POLICY_${process.pid}_${Date.now()}`;
  const receivedHooks = [];
  const upstreamSockets = new Set();

  const hookServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hooks/policy') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      receivedHooks.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(resolve => hookServer.listen(0, '127.0.0.1', resolve));
  const hookUrl = `http://127.0.0.1:${hookServer.address().port}/hooks/policy`;

  fs.writeFileSync(process.env.LLM_PROXY_POLICY_FILE, JSON.stringify({
    outbound: [{ name: 'test-outbound', pattern: outboundMarker, hook_url: hookUrl }],
    inbound: [{ name: 'test-inbound', pattern: inboundMarker, hook_url: hookUrl }],
  }));
  await fetch(`${baseUrl}/api/policies/reload`, { method: 'POST' });

  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write(websocketTextFrame(JSON.stringify({ marker: inboundMarker })));
    setTimeout(() => socket.end(), 50);
  });

  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  PROVIDERS.openai.upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  process.env.OPENAI_API_KEY = 'test-env-ws-key';

  try {
    await new Promise((resolve, reject) => {
      const client = net.connect(new URL(baseUrl).port, '127.0.0.1', () => {
        client.write([
          'GET /openai/realtime?model=test HTTP/1.1',
          `Host: ${new URL(baseUrl).host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Authorization: Bearer client-key',
          '',
          '',
        ].join('\r\n'));
        setTimeout(() => {
          client.write(websocketTextFrame(JSON.stringify({ marker: outboundMarker }), true));
        }, 25);
      });
      setTimeout(() => {
        client.destroy();
        resolve();
      }, 250);
      client.on('error', reject);
    });

    await waitFor(() => receivedHooks.length >= 2);
    const outbound = receivedHooks.find(event => event.rule.name === 'test-outbound');
    const inbound = receivedHooks.find(event => event.rule.name === 'test-inbound');

    assert.ok(outbound, 'expected outbound hook event');
    assert.ok(inbound, 'expected inbound hook event');
    assert.equal(outbound.direction, 'outbound');
    assert.equal(inbound.direction, 'inbound');
    assert.equal(outbound.transport, 'websocket');
    assert.equal(inbound.transport, 'websocket');
    assert.equal(outbound.provider, 'openai');
    assert.equal(Boolean(outbound.request_id), true);
    assert.equal(Boolean(outbound.frame_id), true);
    assert.equal(outbound.payload_snippet.includes(outboundMarker), true);
    assert.equal(inbound.payload_snippet.includes(inboundMarker), true);
  } finally {
    PROVIDERS.openai.upstreamBase = previousBase;
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => hookServer.close(resolve));
    fs.rmSync(process.env.LLM_PROXY_POLICY_FILE, { force: true });
    await fetch(`${baseUrl}/api/policies/reload`, { method: 'POST' });
  }
});

test('.env loader overrides existing shell exports', () => {
  const envPath = path.join(os.tmpdir(), `llm-proxy-env-${process.pid}.env`);
  process.env.LLM_PROXY_ENV_PRIORITY_TEST = 'from-shell';
  fs.writeFileSync(envPath, 'export LLM_PROXY_ENV_PRIORITY_TEST=from-dotenv\n', { mode: 0o600 });

  try {
    loadDotEnv(envPath);
    assert.equal(process.env.LLM_PROXY_ENV_PRIORITY_TEST, 'from-dotenv');
  } finally {
    fs.rmSync(envPath, { force: true });
    delete process.env.LLM_PROXY_ENV_PRIORITY_TEST;
  }
});

function parseJson(text, provider, providerPath, status) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${provider} ${providerPath} returned non-JSON HTTP ${status}: ${snippet(text)}`);
  }
}

function snippet(text) {
  return text.replace(/\s+/g, ' ').slice(0, 500);
}

async function waitFor(check, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('condition was not met before timeout');
}

function websocketTextFrame(text, masked = false) {
  const payload = Buffer.from(text);
  let length;
  if (payload.length < 126) {
    length = Buffer.from([payload.length]);
  } else {
    length = Buffer.from([126, payload.length >> 8, payload.length & 255]);
  }
  const header = Buffer.from([0x81, masked ? length[0] | 0x80 : length[0], ...length.subarray(1)]);
  if (!masked) return Buffer.concat([header, payload]);

  const mask = Buffer.from([1, 2, 3, 4]);
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, maskedPayload]);
}
