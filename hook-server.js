const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const app = express();
const PORT = Number(process.env.HOOK_PORT || 8888);
const TOUCHID_TIMEOUT_MS = Number(process.env.HOOK_TOUCHID_TIMEOUT_MS || 55000);
const TOUCHID_REASON_CHARS = Number(process.env.HOOK_TOUCHID_REASON_CHARS || 1800);
const execFileAsync = promisify(execFile);

app.use(express.json({ limit: process.env.HOOK_BODY_LIMIT || '25mb' }));

const events = [];
const maxEvents = Number(process.env.HOOK_MAX_EVENTS || 500);

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    events: events.length,
    timestamp: new Date().toISOString(),
  });
});

app.get('/events', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), maxEvents);
  res.json({
    events: events.slice(-limit).reverse(),
    total: events.length,
  });
});

app.post('/hooks/policy', async (req, res) => {
  const event = {
    received_at: new Date().toISOString(),
    ...req.body,
  };
  events.push(event);
  while (events.length > maxEvents) events.shift();

  const prompt = buildTouchIDPrompt(event);
  const decision = await requestTouchID(prompt);
  event.decision = decision;

  console.log(JSON.stringify({
    received_at: event.received_at,
    rule: event.rule && event.rule.name,
    direction: event.direction,
    provider: event.provider,
    request_id: event.request_id,
    frame_id: event.frame_id,
    match: event.match,
    allowed: decision.allow,
    error: decision.error,
  }));

  if (!decision.allow) {
    return res.status(403).json(decision);
  }

  res.json(decision);
});

function buildTouchIDPrompt(event) {
  const parts = [
    `llm-proxy policy match: ${event.rule && event.rule.name ? event.rule.name : 'unnamed rule'}`,
    `Direction: ${event.direction || 'unknown'}`,
    `Transport: ${event.transport || 'unknown'}`,
    `Provider: ${event.provider || 'unknown'}`,
    `Endpoint: ${event.endpoint || 'unknown'}`,
  ];

  if (event.frame) {
    parts.push(`Frame: #${event.frame.sequence || '?'} ${event.frame.type || 'unknown'} ${event.frame.bytes || 0} bytes`);
  }

  parts.push(`Offending text: ${stringOrEmpty(event.match)}`);

  const snippet = stringOrEmpty(event.payload_snippet);
  if (snippet && snippet !== event.match) {
    parts.push(`Context: ${snippet}`);
  }

  return truncate(parts.join('\n'), TOUCHID_REASON_CHARS);
}

async function requestTouchID(prompt) {
  try {
    const { command, args, cwd } = touchIDCommand(prompt);
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: TOUCHID_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const response = parseTouchIDResponse(stdout);
    if (response.confirmed === true) {
      return { allow: true, confirmed: true };
    }
    return {
      allow: false,
      confirmed: false,
      reason: response.error || 'Touch ID was not confirmed',
    };
  } catch (error) {
    const response = parseTouchIDResponse(error.stdout);
    return {
      allow: false,
      confirmed: false,
      reason: response.error || error.message || 'Touch ID failed',
      error: response.error || error.message || 'Touch ID failed',
    };
  }
}

function touchIDCommand(prompt) {
  if (process.env.HOOK_TOUCHID_COMMAND) {
    return {
      command: process.env.HOOK_TOUCHID_COMMAND,
      args: [prompt],
      cwd: process.cwd(),
    };
  }

  const triggerDir = path.join(__dirname, 'touchid-trigger');
  const binary = path.join(triggerDir, 'touchid-trigger');
  if (fs.existsSync(binary)) {
    return {
      command: binary,
      args: ['-confirm', prompt],
      cwd: triggerDir,
    };
  }

  return {
    command: 'go',
    args: ['run', '.', '-confirm', prompt],
    cwd: triggerDir,
  };
}

function parseTouchIDResponse(output) {
  if (!output) return {};
  try {
    return JSON.parse(String(output).trim());
  } catch {
    return {};
  }
}

function truncate(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) return value;
  return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function startHookServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`llm-proxy hook server running on http://localhost:${port}`);
  });
}

if (require.main === module) {
  startHookServer();
}

module.exports = {
  app,
  startHookServer,
};
