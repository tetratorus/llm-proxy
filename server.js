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
const WEBSOCKET_LOG_LIMIT = Number(process.env.WEBSOCKET_LOG_LIMIT_CHARS || 5000000);

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
        if (fin && fragmentedOpcode !== null) {
          const completePayload = Buffer.concat(fragmentedPayloads);
          onFrame({
            opcode: fragmentedOpcode,
            type: decodeWebSocketOpcode(fragmentedOpcode),
            payload: readableFramePayload(fragmentedOpcode, completePayload),
            bytes: completePayload.length,
          });
          fragmentedOpcode = null;
          fragmentedPayloads = [];
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          onFrame({
            opcode,
            type: decodeWebSocketOpcode(opcode),
            payload: readableFramePayload(opcode, payload),
            bytes: payload.length,
          });
        } else {
          fragmentedOpcode = opcode;
          fragmentedPayloads = [payload];
        }
      } else {
        onFrame({
          opcode,
          type: decodeWebSocketOpcode(opcode),
          payload: readableFramePayload(opcode, payload),
          bytes: payload.length,
        });
      }
    }
  };
}

function updateWebSocketLog({ requestId, bodyText, responseText, statusCode, responseTime }) {
  db.prepare(`
    UPDATE requests
    SET body = ?, response = ?, status_code = ?, response_time = ?
    WHERE id = ?
  `).run(bodyText, responseText, statusCode, responseTime, requestId);
}

function createWebSocketLogWriter(requestId, startTime) {
  const clientFrames = [];
  const serverFrames = [];

  const serialize = frames => {
    let text = JSON.stringify(frames);
    while (text.length > WEBSOCKET_LOG_LIMIT && frames.length > 1) {
      frames.shift();
      text = JSON.stringify(frames);
    }
    return text;
  };

  const persist = statusCode => {
    updateWebSocketLog({
      requestId,
      bodyText: serialize(clientFrames),
      responseText: serialize(serverFrames),
      statusCode,
      responseTime: Date.now() - startTime,
    });
  };

  return {
    client: createWebSocketFrameParser(frame => {
      clientFrames.push({
        timestamp: new Date().toISOString(),
        direction: 'client',
        type: frame.type,
        bytes: frame.bytes,
        payload: frame.payload,
      });
      persist(101);
    }),
    server: createWebSocketFrameParser(frame => {
      serverFrames.push({
        timestamp: new Date().toISOString(),
        direction: 'server',
        type: frame.type,
        bytes: frame.bytes,
        payload: frame.payload,
      });
      persist(101);
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
    const wsLog = createWebSocketLogWriter(requestId, startTime);
    wsLog.persist(upstreamRes.statusCode);

    socket.write(statusLine(req, upstreamRes.statusCode, upstreamRes.statusMessage));
    socket.write(rawHeaderLines(upstreamRes.rawHeaders, { preserveUpgradeHeaders: true }));
    socket.write('\r\n');
    if (upstreamHead && upstreamHead.length) {
      wsLog.server(upstreamHead);
      socket.write(upstreamHead);
    }
    if (head && head.length) wsLog.client(head);

    socket.on('data', chunk => {
      wsLog.client(chunk);
      upstreamSocket.write(chunk);
    });
    upstreamSocket.on('data', chunk => {
      wsLog.server(chunk);
      socket.write(chunk);
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
    updateRequest({
      requestId,
      responseText: JSON.stringify({ error: 'Proxy upgrade error', message: error.message }),
      statusCode: 502,
      responseTime: Date.now() - startTime,
      model: null,
      usage: null,
    });
    console.error(`Upgrade error for request ${requestId}:`, error);
    socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\n\r\n' +
      JSON.stringify({ error: 'Proxy upgrade error', message: error.message }));
  });

  if (head && head.length) upstreamReq.write(head);
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
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req, provider),
      body: requestBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    forwardResponseHeaders(upstream, res);

    const contentType = upstream.headers.get('content-type') || '';
    const isStream = contentType.includes('text/event-stream') || Boolean(req.body && req.body.stream);

    if (isStream && upstream.body) {
      res.status(upstream.status);
      const chunks = [];
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
        res.write(chunk);
      }

      res.end();
      const responseText = chunks.join('');
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
      `).get(like, like, like, like, like).total;
      requests = db.prepare(`
        SELECT *, COALESCE(json_array_length(json_extract(body, '$.messages')), 0) AS message_count
        FROM requests
        WHERE endpoint LIKE ? OR provider LIKE ? OR model LIKE ? OR body LIKE ? OR response LIKE ?
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `).all(like, like, like, like, like, limit, offset);
    } else {
      total = db.prepare('SELECT COUNT(*) AS total FROM requests').get().total;
      requests = db.prepare(`
        SELECT *, COALESCE(json_array_length(json_extract(body, '$.messages')), 0) AS message_count
        FROM requests
        ORDER BY timestamp DESC
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
    const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(parseRequestRow(request));
  } catch (error) {
    console.error('Error getting request:', error);
    res.status(500).json({ error: 'Failed to get request' });
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
};
