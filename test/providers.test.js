const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.REQUESTS_DB = path.join(os.tmpdir(), `llm-proxy-test-${process.pid}.db`);

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
