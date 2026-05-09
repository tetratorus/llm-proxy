const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

if (process.env.LLM_PROXY_SKIP_DOTENV !== '1') {
  loadDotEnv();
}

const app = express();
const PORT = Number(process.env.PORT || 9999);
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS || 300000);
const DB_PATH = process.env.REQUESTS_DB || 'requests.db';
const WEBSOCKET_FRAME_PAYLOAD_LIMIT = Number(process.env.WEBSOCKET_FRAME_PAYLOAD_LIMIT_CHARS || 1000000);
const WEBSOCKET_SEARCH_SNIPPET_LIMIT = Number(process.env.WEBSOCKET_SEARCH_SNIPPET_LIMIT_CHARS || 500);
const POLICY_FILE = process.env.LLM_PROXY_POLICY_FILE || 'policies.json';
const POLICY_HOOK_URL = process.env.LLM_PROXY_POLICY_HOOK_URL || 'http://127.0.0.1:8888/hooks/policy';
const POLICY_HOOK_TIMEOUT = Number(process.env.LLM_PROXY_POLICY_HOOK_TIMEOUT_MS || 60000);
const POLICY_PAYLOAD_SNIPPET_LIMIT = Number(process.env.LLM_PROXY_POLICY_SNIPPET_CHARS || 4000);

const db = new Database(DB_PATH);

const PROVIDERS = {
  claude: {
    aliases: ['anthropic'],
    upstreamBase: process.env.LLM_PROXY_CLAUDE_BASE_URL || 'https://api.anthropic.com',
    defaultPathPrefix: '/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    authHeader: 'x-api-key',
    extraHeaders: req => ({
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    }),
  },
  openai: {
    upstreamBase: process.env.LLM_PROXY_OPENAI_BASE_URL || 'https://api.openai.com',
    defaultPathPrefix: '/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    authHeader: 'authorization',
  },
  deepseek: {
    upstreamBase: process.env.LLM_PROXY_DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    defaultPathPrefix: '',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    authHeader: 'authorization',
  },
  gemini: {
    aliases: ['google'],
    upstreamBase: process.env.LLM_PROXY_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
    defaultPathPrefix: '/v1beta',
    absolutePathPrefixes: ['/upload/'],
    apiKeyEnv: 'GEMINI_API_KEY',
    authHeader: 'x-goog-api-key',
  },
  openrouter: {
    upstreamBase: process.env.LLM_PROXY_OPENROUTER_BASE_URL || 'https://openrouter.ai/api',
    defaultPathPrefix: '/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    authHeader: 'authorization',
    extraHeaders: () => ({
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:9999',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'llm-proxy',
    }),
  },
  xai: {
    aliases: ['grok'],
    upstreamBase: process.env.LLM_PROXY_XAI_BASE_URL || 'https://api.x.ai',
    defaultPathPrefix: '/v1',
    apiKeyEnv: 'XAI_API_KEY',
    authHeader: 'authorization',
  },
};

const PROVIDER_BY_PREFIX = new Map();
for (const [name, config] of Object.entries(PROVIDERS)) {
  PROVIDER_BY_PREFIX.set(name, { name, config });
  for (const alias of config.aliases || []) {
    PROVIDER_BY_PREFIX.set(alias, { name, config });
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    provider TEXT,
    upstream_url TEXT,
    method TEXT,
    endpoint TEXT,
    headers TEXT,
    body TEXT,
    response TEXT,
    status_code INTEGER,
    response_time INTEGER,
    model TEXT,
    original_model TEXT,
    routed_model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    user_agent TEXT,
    content_type TEXT,
    session_id TEXT
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_timestamp ON requests(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_endpoint ON requests(endpoint);
  CREATE INDEX IF NOT EXISTS idx_provider ON requests(provider);
  CREATE INDEX IF NOT EXISTS idx_model ON requests(model);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS websocket_frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    sequence INTEGER NOT NULL,
    direction TEXT NOT NULL,
    opcode INTEGER,
    type TEXT,
    bytes INTEGER,
    payload TEXT,
    FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ws_frames_request ON websocket_frames(request_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_ws_frames_payload ON websocket_frames(payload);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS policy_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    request_id TEXT,
    frame_id INTEGER,
    direction TEXT,
    rule_name TEXT,
    pattern TEXT,
    hook_url TEXT,
    status TEXT,
    error TEXT,
    payload_snippet TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_policy_events_request ON policy_events(request_id, timestamp);
`);

migrateInlineWebSocketFrames();

app.use(express.json({ limit: '50mb', type: ['application/json', 'application/*+json'] }));
app.use(express.text({ limit: '50mb', type: ['text/*', 'application/x-ndjson'] }));
app.use(express.raw({
  limit: '50mb',
  type: [
    'application/octet-stream',
    'multipart/*',
    'image/*',
    'audio/*',
    'video/*',
    'application/pdf',
  ],
}));
app.use(express.static('.'));

function normalizePath(path) {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${normalizePath(path)}`;
}

function stripProviderPrefix(path) {
  const match = path.match(/^\/([^/?#]+)(\/.*)?$/);
  if (!match) return null;
  const provider = PROVIDER_BY_PREFIX.get(match[1].toLowerCase());
  if (!provider) return null;
  return {
    ...provider,
    publicPrefix: match[1],
    providerPath: normalizePath(match[2] || '/'),
  };
}

function upstreamPathFor(config, providerPath) {
  const path = normalizePath(providerPath);
  if ((config.absolutePathPrefixes || []).some(prefix => path.startsWith(prefix))) {
    return path;
  }
  if (!config.defaultPathPrefix || path === '/') return path;
  if (path === config.defaultPathPrefix || path.startsWith(`${config.defaultPathPrefix}/`)) {
    return path;
  }
  return `${config.defaultPathPrefix}${path}`;
}

function loadDotEnv(path = '.env') {
  if (!fs.existsSync(path)) return;
  const content = fs.readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function loadPolicyConfig() {
  if (!fs.existsSync(POLICY_FILE)) {
    return { source: null, outbound: [], inbound: [] };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
    return {
      source: POLICY_FILE,
      outbound: compilePolicyRules(raw.outbound || []),
      inbound: compilePolicyRules(raw.inbound || []),
    };
  } catch (error) {
    console.error(`Failed to load policy file ${POLICY_FILE}:`, error.message);
    return { source: POLICY_FILE, outbound: [], inbound: [] };
  }
}

function compilePolicyRules(rules) {
  return rules
    .filter(rule => rule && rule.enabled !== false && rule.pattern)
    .map(rule => {
      try {
        return {
          name: rule.name || 'unnamed-policy',
          pattern: rule.pattern,
          flags: rule.flags || 'i',
          hookUrl: rule.hook_url || POLICY_HOOK_URL,
          regex: new RegExp(rule.pattern, rule.flags || 'i'),
        };
      } catch (error) {
        console.error(`Invalid policy regex ${rule.name || rule.pattern}:`, error.message);
        return null;
      }
    })
    .filter(Boolean);
}

let policyConfig = loadPolicyConfig();

function reloadPolicyConfig() {
  policyConfig = loadPolicyConfig();
  return policyConfig;
}

function generateConversationId(body) {
  const messages = body && (body.messages || body.contents || body.input);
  if (!messages) return crypto.randomBytes(6).toString('hex');
  const normalized = JSON.stringify(messages).replace(/"cache_control":\{[^}]*\},?/g, '');
  return crypto.createHash('md5').update(normalized.slice(0, 20000)).digest('hex').substring(0, 12);
}

function sanitizeHeaders(headers) {
  const sensitiveKeys = ['authorization', 'api-key', 'x-api-key', 'token', 'secret', 'cookie', 'key'];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
}

function safeJson(value) {
  if (value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function extractModel(body, responseText) {
  if (body && body.model) return body.model;
  try {
    const parsed = JSON.parse(responseText);
    return parsed.model || parsed.id || null;
  } catch {
    return null;
  }
}

function extractTokenUsage(responseText) {
  try {
    const parsed = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
    const usage = parsed.usage || parsed.response_metadata?.token_usage;
    if (!usage) return null;
    return {
      input_tokens: usage.input_tokens || usage.prompt_tokens || usage.total_input_tokens || 0,
      output_tokens: usage.output_tokens || usage.completion_tokens || usage.total_output_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    };
  } catch {
    return null;
  }
}

function parseSSEStream(sseText) {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let model = null;

  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const dataStr = line.substring(6).trim();
    if (!dataStr || dataStr === '[DONE]') continue;

    try {
      const data = JSON.parse(dataStr);
      model = model || data.model || data.message?.model || null;
      const eventUsage = data.usage || data.message?.usage;
      if (eventUsage) {
        usage.input_tokens = eventUsage.input_tokens || eventUsage.prompt_tokens || usage.input_tokens;
        usage.output_tokens = eventUsage.output_tokens || eventUsage.completion_tokens || usage.output_tokens;
        usage.cache_creation_input_tokens = eventUsage.cache_creation_input_tokens || usage.cache_creation_input_tokens;
        usage.cache_read_input_tokens = eventUsage.cache_read_input_tokens || usage.cache_read_input_tokens;
      }
    } catch {
      // Ignore incomplete or provider-specific stream chunks.
    }
  }

  return { model, usage };
}

function truncateText(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) return value;
  return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

function parseJsonArray(value) {
  if (!value || typeof value !== 'string' || value[0] !== '[') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function migrateInlineWebSocketFrames() {
  const rows = db.prepare(`
    SELECT id, body, response
    FROM requests
    WHERE method = 'GET'
      AND status_code = 101
      AND (
        (body IS NOT NULL AND body LIKE '[{%')
        OR (response IS NOT NULL AND response LIKE '[{%')
      )
      AND NOT EXISTS (
        SELECT 1 FROM websocket_frames WHERE websocket_frames.request_id = requests.id
      )
  `).all();

  if (!rows.length) return;

  const insertFrame = db.prepare(`
    INSERT INTO websocket_frames (
      request_id, timestamp, sequence, direction, opcode, type, bytes, payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateRequestSummary = db.prepare(`
    UPDATE requests
    SET body = ?, response = ?
    WHERE id = ?
  `);

  const migrate = db.transaction(rowsToMigrate => {
    for (const row of rowsToMigrate) {
      const frames = [
        ...(parseJsonArray(row.body) || []),
        ...(parseJsonArray(row.response) || []),
      ].sort((left, right) => String(left.timestamp || '').localeCompare(String(right.timestamp || '')));

      let sequence = 0;
      const counts = { client: 0, server: 0 };
      for (const frame of frames) {
        sequence += 1;
        const direction = frame.direction || 'unknown';
        if (direction === 'client' || direction === 'server') counts[direction] += 1;
        insertFrame.run(
          row.id,
          frame.timestamp || new Date().toISOString(),
          sequence,
          direction,
          frame.opcode ?? null,
          frame.type || null,
          frame.bytes ?? Buffer.byteLength(String(frame.payload || '')),
          truncateText(String(frame.payload || ''), WEBSOCKET_FRAME_PAYLOAD_LIMIT)
        );
      }

      updateRequestSummary.run(
        JSON.stringify({ websocket: true, frames: counts.client, log: 'See websocket_frames' }),
        JSON.stringify({ websocket: true, frames: counts.server, log: 'See websocket_frames' }),
        row.id
      );
    }
  });

  migrate(rows);
}

function shouldSkipHeader(header) {
  return [
    'connection',
    'content-encoding',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ].includes(header.toLowerCase());
}

function buildUpstreamHeaders(req, provider, options = {}) {
  const headers = {};
  const preserveUpgradeHeaders = Boolean(options.preserveUpgradeHeaders);
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    const isUpgradeHeader = lowerKey === 'connection' || lowerKey === 'upgrade';
    if (shouldSkipHeader(key) && !(preserveUpgradeHeaders && isUpgradeHeader)) continue;
    if (preserveUpgradeHeaders && lowerKey === 'sec-websocket-extensions') continue;
    headers[key] = value;
  }

  headers.host = undefined;
  headers['content-type'] = headers['content-type'] || 'application/json';

  const apiKey = provider.config.apiKeyEnv ? process.env[provider.config.apiKeyEnv] : null;
  if (apiKey && provider.config.authHeader) {
    const authHeader = provider.config.authHeader;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === authHeader) delete headers[key];
    }
    if (authHeader === 'authorization') {
      headers.authorization = `Bearer ${apiKey}`;
    } else {
      headers[authHeader] = apiKey;
    }
  }

  Object.assign(headers, provider.config.extraHeaders ? provider.config.extraHeaders(req) : {});

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) delete headers[key];
  }

  return headers;
}

function statusLine(req, statusCode, statusMessage) {
  return `HTTP/${req.httpVersion} ${statusCode} ${statusMessage || http.STATUS_CODES[statusCode] || ''}\r\n`;
}

function rawHeaderLines(headers, options = {}) {
  const lines = [];
  const preserveUpgradeHeaders = Boolean(options.preserveUpgradeHeaders);
  for (let index = 0; index < headers.length; index += 2) {
    const lowerKey = headers[index].toLowerCase();
    const isUpgradeHeader = lowerKey === 'connection' || lowerKey === 'upgrade';
    if (shouldSkipHeader(headers[index]) && !(preserveUpgradeHeaders && isUpgradeHeader)) continue;
    if (preserveUpgradeHeaders && lowerKey === 'sec-websocket-extensions') continue;
    lines.push(`${headers[index]}: ${headers[index + 1]}\r\n`);
  }
  return lines.join('');
}

function decodeWebSocketOpcode(opcode) {
  return {
    0x0: 'continuation',
    0x1: 'text',
    0x2: 'binary',
    0x8: 'close',
    0x9: 'ping',
    0xa: 'pong',
  }[opcode] || `opcode_${opcode}`;
}

function readableFramePayload(opcode, payload) {
  if (opcode === 0x1) return payload.toString('utf8');
  if (opcode === 0x2) {
    const text = payload.toString('utf8');
    if (!text.includes('\uFFFD')) return text;
    return `[binary base64] ${payload.toString('base64')}`;
  }
  return payload.length ? payload.toString('base64') : '';
}

function createWebSocketFrameParser(onFrame) {
  let buffer = Buffer.alloc(0);
  let fragmentedOpcode = null;
  let fragmentedPayloads = [];
  let fragmentedRawFrames = [];
  let pending = Promise.resolve();

  const emitFrame = frame => {
    pending = pending.then(() => onFrame(frame)).catch(error => {
      console.error('WebSocket frame handler error:', error);
    });
  };

  return chunk => {
    if (!chunk || !chunk.length) return;
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const fin = Boolean(firstByte & 0x80);
      const opcode = firstByte & 0x0f;
      const masked = Boolean(secondByte & 0x80);
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < offset + 2) return;
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) return;
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          buffer = Buffer.alloc(0);
          return;
        }
        payloadLength = Number(bigLength);
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + payloadLength) return;

      const rawFrame = Buffer.from(buffer.subarray(0, offset + payloadLength));
      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      buffer = buffer.subarray(offset + payloadLength);

      if (opcode === 0x0) {
        fragmentedPayloads.push(payload);
        fragmentedRawFrames.push(rawFrame);
        if (fin && fragmentedOpcode !== null) {
          const completePayload = Buffer.concat(fragmentedPayloads);
          emitFrame({
            opcode: fragmentedOpcode,
            type: decodeWebSocketOpcode(fragmentedOpcode),
            payload: readableFramePayload(fragmentedOpcode, completePayload),
            bytes: completePayload.length,
            raw: Buffer.concat(fragmentedRawFrames),
          });
          fragmentedOpcode = null;
          fragmentedPayloads = [];
          fragmentedRawFrames = [];
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          emitFrame({
            opcode,
            type: decodeWebSocketOpcode(opcode),
            payload: readableFramePayload(opcode, payload),
            bytes: payload.length,
            raw: rawFrame,
          });
        } else {
          fragmentedOpcode = opcode;
          fragmentedPayloads = [payload];
          fragmentedRawFrames = [rawFrame];
        }
      } else {
        emitFrame({
          opcode,
          type: decodeWebSocketOpcode(opcode),
          payload: readableFramePayload(opcode, payload),
          bytes: payload.length,
          raw: rawFrame,
        });
      }
    }
  };
}

function updateWebSocketStatus({ requestId, statusCode, responseTime }) {
  db.prepare(`
    UPDATE requests
    SET status_code = ?, response_time = ?
    WHERE id = ?
  `).run(statusCode, responseTime, requestId);
}

function updateWebSocketSummary({ requestId, clientFrames, serverFrames, statusCode, responseTime }) {
  db.prepare(`
    UPDATE requests
    SET body = ?, response = ?, status_code = ?, response_time = ?
    WHERE id = ?
  `).run(
    JSON.stringify({ websocket: true, frames: clientFrames, log: 'See websocket_frames' }),
    JSON.stringify({ websocket: true, frames: serverFrames, log: 'See websocket_frames' }),
    statusCode,
    responseTime,
    requestId
  );
}

function insertPolicyEvent({ requestId, frameId, direction, rule, hookUrl, status, error, payloadSnippet }) {
  db.prepare(`
    INSERT INTO policy_events (
      request_id, frame_id, direction, rule_name, pattern, hook_url, status, error, payload_snippet
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestId,
    frameId || null,
    direction,
    rule.name,
    rule.pattern,
    hookUrl,
    status,
    error || null,
    payloadSnippet
  );
}

async function postPolicyHook(hookUrl, event) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POLICY_HOOK_TIMEOUT);

  try {
    const response = await fetch(hookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }

    const allowed = response.ok && body.allow === true;
    insertPolicyEvent({
      requestId: event.request_id,
      frameId: event.frame_id,
      direction: event.direction,
      rule: event.rule,
      hookUrl,
      status: allowed ? 'allowed' : (response.ok ? 'denied' : `http_${response.status}`),
      error: allowed ? null : (body.reason || body.error || null),
      payloadSnippet: event.payload_snippet,
    });

    return {
      allowed,
      reason: body.reason || body.error || (allowed ? null : `Hook returned HTTP ${response.status}`),
    };
  } catch (error) {
    clearTimeout(timeout);
    insertPolicyEvent({
      requestId: event.request_id,
      frameId: event.frame_id,
      direction: event.direction,
      rule: event.rule,
      hookUrl,
      status: 'failed',
      error: error.message,
      payloadSnippet: event.payload_snippet,
    });
    return { allowed: false, reason: error.message };
  }
}

async function evaluatePolicyHooks({ requestId, frameId, provider, endpoint, upstreamUrl, direction, transport, frame, payload }) {
  const rules = direction === 'outbound' ? policyConfig.outbound : policyConfig.inbound;
  if (!rules.length || typeof payload !== 'string') return { allowed: true, matched: false };

  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    const match = rule.regex.exec(payload);
    if (!match) continue;

    const event = {
      event: 'policy.match',
      timestamp: new Date().toISOString(),
      policy_source: policyConfig.source,
      request_id: requestId,
      frame_id: frameId || null,
      provider,
      endpoint,
      upstream_url: upstreamUrl,
      direction,
      transport,
      frame: frame ? {
        sequence: frame.sequence,
        opcode: frame.opcode,
        type: frame.type,
        bytes: frame.bytes,
      } : null,
      rule: {
        name: rule.name,
        pattern: rule.pattern,
        flags: rule.flags,
      },
      match: match[0],
      match_index: match.index,
      payload_bytes: Buffer.byteLength(payload),
      payload_snippet: truncateText(payload, POLICY_PAYLOAD_SNIPPET_LIMIT),
    };

    const decision = await postPolicyHook(rule.hookUrl, event);
    if (!decision.allowed) {
      return {
        allowed: false,
        matched: true,
        rule: rule.name,
        reason: decision.reason || `Policy hook denied ${rule.name}`,
      };
    }
  }

  return { allowed: true, matched: true };
}

function createWebSocketLogWriter({
  requestId,
  startTime,
  provider,
  endpoint,
  upstreamUrl,
  forwardClientFrame,
  forwardServerFrame,
  blockConnection,
}) {
  let sequence = 0;
  let clientFrames = 0;
  let serverFrames = 0;
  const insertFrame = db.prepare(`
    INSERT INTO websocket_frames (
      request_id, timestamp, sequence, direction, opcode, type, bytes, payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const persist = statusCode => {
    updateWebSocketSummary({
      requestId,
      clientFrames,
      serverFrames,
      statusCode,
      responseTime: Date.now() - startTime,
    });
  };

  const record = async (direction, frame) => {
    sequence += 1;
    if (direction === 'client') clientFrames += 1;
    if (direction === 'server') serverFrames += 1;
    insertFrame.run(
      requestId,
      new Date().toISOString(),
      sequence,
      direction,
      frame.opcode,
      frame.type,
      frame.bytes,
      truncateText(frame.payload, WEBSOCKET_FRAME_PAYLOAD_LIMIT)
    );
    const frameId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    const directionName = direction === 'client' ? 'outbound' : 'inbound';
    return evaluatePolicyHooks({
      requestId,
      frameId,
      provider,
      endpoint,
      upstreamUrl,
      direction: directionName,
      transport: 'websocket',
      frame: { ...frame, sequence },
      payload: frame.payload,
    });
  };

  return {
    client: createWebSocketFrameParser(async frame => {
      const decision = await record('client', frame);
      persist(101);
      if (decision.allowed) {
        forwardClientFrame(frame.raw);
      } else {
        blockConnection(decision);
      }
      return decision;
    }),
    server: createWebSocketFrameParser(async frame => {
      const decision = await record('server', frame);
      persist(101);
      if (decision.allowed) {
        forwardServerFrame(frame.raw);
      } else {
        blockConnection(decision);
      }
      return decision;
    }),
    persist,
  };
}

function loggableUpgradeRequest(req, originalUrl) {
  return {
    method: req.method,
    originalUrl,
    headers: req.headers,
    body: undefined,
  };
}

function handleUpgrade(req, socket, head) {
  const originalUrl = req.url || '/';
  const parsedUrl = new URL(originalUrl, `http://${req.headers.host || 'localhost'}`);
  const provider = stripProviderPrefix(parsedUrl.pathname);

  if (!provider) {
    socket.destroy();
    return;
  }

  const requestId = crypto.randomBytes(8).toString('hex');
  const startTime = Date.now();
  const providerPath = upstreamPathFor(provider.config, provider.providerPath);
  const upstreamUrl = new URL(joinUrl(provider.config.upstreamBase, providerPath) + parsedUrl.search);
  const protocol = upstreamUrl.protocol === 'http:' ? http : https;
  const logReq = loggableUpgradeRequest(req, originalUrl);

  insertRequest({
    requestId,
    req: logReq,
    provider,
    upstreamUrl: upstreamUrl.toString(),
    bodyText: null,
    originalModel: null,
    conversationId: crypto.randomBytes(6).toString('hex'),
  });

  console.log(`Upgrade ${requestId} ${provider.name} ${req.method} ${originalUrl} -> ${upstreamUrl.toString()}`);

  const upstreamReq = protocol.request({
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || undefined,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    method: req.method,
    headers: buildUpstreamHeaders(req, provider, { preserveUpgradeHeaders: true }),
  });

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    let blocked = false;
    const blockConnection = decision => {
      if (blocked) return;
      blocked = true;
      const reason = decision.reason || `Policy hook denied ${decision.rule || 'matched rule'}`;
      db.prepare('UPDATE requests SET response = ?, status_code = ?, response_time = ? WHERE id = ?')
        .run(JSON.stringify({ error: 'Policy blocked WebSocket frame', reason }), 403, Date.now() - startTime, requestId);
      console.error(`Policy blocked WebSocket request ${requestId}: ${reason}`);
      socket.end();
      upstreamSocket.end();
    };
    const wsLog = createWebSocketLogWriter({
      requestId,
      startTime,
      provider: provider.name,
      endpoint: originalUrl,
      upstreamUrl: upstreamUrl.toString(),
      forwardClientFrame: frame => {
        if (!blocked) upstreamSocket.write(frame);
      },
      forwardServerFrame: frame => {
        if (!blocked) socket.write(frame);
      },
      blockConnection,
    });
    wsLog.persist(upstreamRes.statusCode);

    socket.write(statusLine(req, upstreamRes.statusCode, upstreamRes.statusMessage));
    socket.write(rawHeaderLines(upstreamRes.rawHeaders, { preserveUpgradeHeaders: true }));
    socket.write('\r\n');
    if (upstreamHead && upstreamHead.length) wsLog.server(upstreamHead);
    if (head && head.length) wsLog.client(head);

    socket.on('data', chunk => {
      wsLog.client(chunk);
    });
    upstreamSocket.on('data', chunk => {
      wsLog.server(chunk);
    });
    socket.on('end', () => upstreamSocket.end());
    upstreamSocket.on('end', () => socket.end());
    socket.on('close', () => {
      wsLog.persist(upstreamRes.statusCode);
      upstreamSocket.destroy();
    });
    upstreamSocket.on('close', () => {
      wsLog.persist(upstreamRes.statusCode);
      socket.destroy();
    });
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
  });

  upstreamReq.on('response', upstreamRes => {
    const chunks = [];
    upstreamRes.on('data', chunk => chunks.push(chunk));
    upstreamRes.on('end', () => {
      const responseBody = Buffer.concat(chunks);
      updateRequest({
        requestId,
        responseText: responseBody.toString('utf8'),
        statusCode: upstreamRes.statusCode,
        responseTime: Date.now() - startTime,
        model: null,
        usage: null,
      });

      socket.write(statusLine(req, upstreamRes.statusCode, upstreamRes.statusMessage));
      socket.write(rawHeaderLines(upstreamRes.rawHeaders));
      socket.write('\r\n');
      socket.write(responseBody);
      socket.end();
    });
  });

  upstreamReq.on('error', error => {
    updateWebSocketStatus({
      requestId,
      statusCode: 502,
      responseTime: Date.now() - startTime,
    });
    db.prepare('UPDATE requests SET response = ? WHERE id = ?')
      .run(JSON.stringify({ error: 'Proxy upgrade error', message: error.message }), requestId);
    console.error(`Upgrade error for request ${requestId}:`, error);
    socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\n\r\n' +
      JSON.stringify({ error: 'Proxy upgrade error', message: error.message }));
  });

  upstreamReq.end();
}

function forwardResponseHeaders(upstream, res) {
  for (const [key, value] of upstream.headers.entries()) {
    if (shouldSkipHeader(key)) continue;
    res.setHeader(key, value);
  }
}

function buildBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body;
  if (req.body === undefined) return undefined;
  return JSON.stringify(req.body);
}

function insertRequest({ requestId, req, provider, upstreamUrl, bodyText, originalModel, conversationId }) {
  db.prepare(`
    INSERT INTO requests (
      id, provider, upstream_url, method, endpoint, headers, body, original_model,
      routed_model, user_agent, content_type, session_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestId,
    provider.name,
    upstreamUrl,
    req.method,
    req.originalUrl,
    JSON.stringify(sanitizeHeaders(req.headers)),
    bodyText,
    originalModel,
    originalModel,
    req.headers['user-agent'] || null,
    req.headers['content-type'] || null,
    conversationId
  );
}

function updateRequest({ requestId, responseText, statusCode, responseTime, model, usage }) {
  db.prepare(`
    UPDATE requests
    SET response = ?, status_code = ?, response_time = ?, model = ?,
        input_tokens = ?, output_tokens = ?,
        cache_creation_input_tokens = ?, cache_read_input_tokens = ?
    WHERE id = ?
  `).run(
    responseText,
    statusCode,
    responseTime,
    model,
    usage ? usage.input_tokens : null,
    usage ? usage.output_tokens : null,
    usage ? usage.cache_creation_input_tokens : null,
    usage ? usage.cache_read_input_tokens : null,
    requestId
  );
}

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    providers: Object.keys(PROVIDERS),
  });
});

app.get('/providers', (req, res) => {
  res.json({
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([name, config]) => [
      name,
      {
        base_url: `http://localhost:${PORT}/${name}`,
        aliases: config.aliases || [],
        upstream_base: config.upstreamBase.replace(/\/\/[^/@]+@/, '//[REDACTED]@'),
        default_path_prefix: config.defaultPathPrefix || null,
        api_key_env: config.apiKeyEnv || null,
      },
    ])),
  });
});

app.post('/api/policies/reload', (req, res) => {
  const config = reloadPolicyConfig();
  res.json({
    source: config.source,
    outbound_rules: config.outbound.length,
    inbound_rules: config.inbound.length,
    hook_url: POLICY_HOOK_URL,
  });
});

app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/providers') {
    return next();
  }

  const provider = stripProviderPrefix(req.path);
  if (!provider) {
    return next();
  }

  const requestId = crypto.randomBytes(8).toString('hex');
  const startTime = Date.now();
  const providerPath = upstreamPathFor(provider.config, provider.providerPath);
  const upstreamUrl = joinUrl(provider.config.upstreamBase, providerPath) + (req.url.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '');
  const originalModel = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body.model : null;
  const requestBody = buildBody(req);
  const bodyText = safeJson(req.body);

  insertRequest({
    requestId,
    req,
    provider,
    upstreamUrl,
    bodyText,
    originalModel,
    conversationId: generateConversationId(req.body),
  });

  console.log(`Request ${requestId} ${provider.name} ${req.method} ${req.originalUrl} -> ${upstreamUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const outboundDecision = await evaluatePolicyHooks({
      requestId,
      frameId: null,
      provider: provider.name,
      endpoint: req.originalUrl,
      upstreamUrl,
      direction: 'outbound',
      transport: 'http',
      frame: null,
      payload: bodyText || '',
    });
    if (!outboundDecision.allowed) {
      clearTimeout(timeoutId);
      const responseText = JSON.stringify({
        error: 'Policy blocked outbound request',
        reason: outboundDecision.reason,
      });
      updateRequest({
        requestId,
        responseText,
        statusCode: 403,
        responseTime: Date.now() - startTime,
        model: originalModel,
        usage: null,
      });
      return res.status(403).json(JSON.parse(responseText));
    }

    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req, provider),
      body: requestBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const contentType = upstream.headers.get('content-type') || '';
    const isStream = contentType.includes('text/event-stream') || Boolean(req.body && req.body.stream);

    if (isStream && upstream.body) {
      const chunks = [];
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
      }

      const responseText = chunks.join('');
      const inboundDecision = await evaluatePolicyHooks({
        requestId,
        frameId: null,
        provider: provider.name,
        endpoint: req.originalUrl,
        upstreamUrl,
        direction: 'inbound',
        transport: 'http-stream',
        frame: null,
        payload: responseText || '',
      });
      if (!inboundDecision.allowed) {
        updateRequest({
          requestId,
          responseText: JSON.stringify({ error: 'Policy blocked inbound response', reason: inboundDecision.reason }),
          statusCode: 403,
          responseTime: Date.now() - startTime,
          model: originalModel,
          usage: null,
        });
        return res.status(403).json({ error: 'Policy blocked inbound response', reason: inboundDecision.reason });
      }

      forwardResponseHeaders(upstream, res);
      res.status(upstream.status);
      for (const chunk of chunks) res.write(chunk);
      res.end();
      const parsed = parseSSEStream(responseText);
      updateRequest({
        requestId,
        responseText,
        statusCode: upstream.status,
        responseTime: Date.now() - startTime,
        model: parsed.model || originalModel,
        usage: parsed.usage,
      });
      return;
    }

    const responseText = await upstream.text();
    const inboundDecision = await evaluatePolicyHooks({
      requestId,
      frameId: null,
      provider: provider.name,
      endpoint: req.originalUrl,
      upstreamUrl,
      direction: 'inbound',
      transport: 'http',
      frame: null,
      payload: responseText || '',
    });
    if (!inboundDecision.allowed) {
      updateRequest({
        requestId,
        responseText: JSON.stringify({ error: 'Policy blocked inbound response', reason: inboundDecision.reason }),
        statusCode: 403,
        responseTime: Date.now() - startTime,
        model: originalModel,
        usage: null,
      });
      return res.status(403).json({ error: 'Policy blocked inbound response', reason: inboundDecision.reason });
    }

    forwardResponseHeaders(upstream, res);
    const usage = extractTokenUsage(responseText);
    updateRequest({
      requestId,
      responseText,
      statusCode: upstream.status,
      responseTime: Date.now() - startTime,
      model: extractModel(req.body, responseText) || originalModel,
      usage,
    });

    res.status(upstream.status)
      .setHeader('content-type', contentType || 'application/json')
      .send(responseText);
  } catch (error) {
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    updateRequest({
      requestId,
      responseText: JSON.stringify({ error: 'Proxy error', message: error.message }),
      statusCode: 502,
      responseTime,
      model: originalModel,
      usage: null,
    });
    console.error(`Error for request ${requestId}:`, error);
    res.status(502).json({ error: 'Proxy error', message: error.message });
  }
});

app.get('/api/requests', (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();

    let total;
    let requests;

    if (search) {
      const like = `%${search}%`;
      total = db.prepare(`
        SELECT COUNT(*) AS total
        FROM requests
        WHERE endpoint LIKE ? OR provider LIKE ? OR model LIKE ? OR body LIKE ? OR response LIKE ?
          OR EXISTS (
            SELECT 1 FROM websocket_frames
            WHERE websocket_frames.request_id = requests.id
              AND websocket_frames.payload LIKE ?
          )
      `).get(like, like, like, like, like, like).total;
      requests = db.prepare(`
        SELECT
          requests.*,
          COALESCE(json_array_length(json_extract(requests.body, '$.messages')), 0) AS message_count,
          (
            SELECT COUNT(*)
            FROM websocket_frames
            WHERE websocket_frames.request_id = requests.id
          ) AS websocket_frame_count,
          (
            SELECT json_group_array(json_object(
              'sequence', sequence,
              'timestamp', timestamp,
              'direction', direction,
              'type', type,
              'bytes', bytes,
              'snippet', substr(payload, max(1, instr(payload, ?) - 160), ?)
            ))
            FROM (
              SELECT sequence, timestamp, direction, type, bytes, payload
              FROM websocket_frames
              WHERE websocket_frames.request_id = requests.id
                AND payload LIKE ?
              ORDER BY sequence
              LIMIT 5
            )
          ) AS websocket_matches
        FROM requests
        WHERE endpoint LIKE ? OR provider LIKE ? OR model LIKE ? OR body LIKE ? OR response LIKE ?
          OR EXISTS (
            SELECT 1 FROM websocket_frames
            WHERE websocket_frames.request_id = requests.id
              AND websocket_frames.payload LIKE ?
          )
        ORDER BY requests.timestamp DESC
        LIMIT ? OFFSET ?
      `).all(search, WEBSOCKET_SEARCH_SNIPPET_LIMIT, like, like, like, like, like, like, like, limit, offset);
    } else {
      total = db.prepare('SELECT COUNT(*) AS total FROM requests').get().total;
      requests = db.prepare(`
        SELECT
          requests.*,
          COALESCE(json_array_length(json_extract(requests.body, '$.messages')), 0) AS message_count,
          (
            SELECT COUNT(*)
            FROM websocket_frames
            WHERE websocket_frames.request_id = requests.id
          ) AS websocket_frame_count,
          NULL AS websocket_matches
        FROM requests
        ORDER BY requests.timestamp DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
    }

    res.json({
      requests: requests.map(parseRequestRow),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error getting requests:', error);
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

app.get('/api/requests/:id', (req, res) => {
  try {
    const request = db.prepare(`
      SELECT
        requests.*,
        (
          SELECT COUNT(*)
          FROM websocket_frames
          WHERE websocket_frames.request_id = requests.id
        ) AS websocket_frame_count
      FROM requests
      WHERE id = ?
    `).get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(parseRequestRow(request));
  } catch (error) {
    console.error('Error getting request:', error);
    res.status(500).json({ error: 'Failed to get request' });
  }
});

app.get('/api/requests/:id/websocket-frames', (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const request = db.prepare('SELECT id FROM requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    let total;
    let frames;
    if (search) {
      const like = `%${search}%`;
      total = db.prepare(`
        SELECT COUNT(*) AS total
        FROM websocket_frames
        WHERE request_id = ? AND payload LIKE ?
      `).get(req.params.id, like).total;
      frames = db.prepare(`
        SELECT *
        FROM websocket_frames
        WHERE request_id = ? AND payload LIKE ?
        ORDER BY sequence
        LIMIT ? OFFSET ?
      `).all(req.params.id, like, limit, offset);
    } else {
      total = db.prepare(`
        SELECT COUNT(*) AS total
        FROM websocket_frames
        WHERE request_id = ?
      `).get(req.params.id).total;
      frames = db.prepare(`
        SELECT *
        FROM websocket_frames
        WHERE request_id = ?
        ORDER BY sequence
        LIMIT ? OFFSET ?
      `).all(req.params.id, limit, offset);
    }

    res.json({
      frames,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error getting websocket frames:', error);
    res.status(500).json({ error: 'Failed to get websocket frames' });
  }
});

app.get('/api/requests/:id/history', (req, res) => {
  res.json({ prev_requests: [], has_more: false });
});

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  if (value.startsWith('data:')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseRequestRow(row) {
  return {
    ...row,
    headers: parseMaybeJson(row.headers),
    body: parseMaybeJson(row.body),
    response: parseMaybeJson(row.response),
    message_count: row.message_count || 0,
    websocket_frame_count: row.websocket_frame_count || 0,
    websocket_matches: parseMaybeJson(row.websocket_matches) || [],
  };
}

function startServer(port = PORT) {
  const server = app.listen(port, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`llm-proxy running on http://localhost:${actualPort}`);
    console.log(`request database: ${DB_PATH}`);
    console.log('provider base URLs:');
    for (const name of Object.keys(PROVIDERS)) {
      console.log(`  ${name}: http://localhost:${actualPort}/${name}`);
    }
  });
  server.on('upgrade', handleUpgrade);
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  loadDotEnv,
  startServer,
  PROVIDERS,
  upstreamPathFor,
  buildUpstreamHeaders,
  reloadPolicyConfig,
};
