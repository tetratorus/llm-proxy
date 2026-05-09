const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const toml = require('smol-toml');
const { approveByVoice } = require('./voice-approver');
const { approveByLocalVoice } = require('./local-voice-approver');

const app = express();

function loadPolicyApprover() {
  const file = process.env.LLM_PROXY_POLICY_FILE || path.join(__dirname, 'policies.toml');
  try {
    const parsed = toml.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed.approver === 'string') return parsed.approver;
  } catch (error) {
    console.error(`failed to read approver from ${file}:`, error.message);
  }
  return null;
}

const APPROVER = (process.env.HOOK_APPROVER || loadPolicyApprover() || 'deny').toLowerCase();
const PORT = Number(process.env.HOOK_PORT || 8888);
const TOUCHID_TIMEOUT_MS = Number(process.env.HOOK_TOUCHID_TIMEOUT_MS || 55000);
const TOUCHID_REASON_CHARS = Number(process.env.HOOK_TOUCHID_REASON_CHARS || 1800);
const REDACTION = process.env.HOOK_REDACTION || '[REDACTED_BY_LLM_PROXY_POLICY]';
const DECISIONS_LOG = process.env.HOOK_DECISIONS_LOG || path.join(__dirname, 'user_decisions.jsonl');
const execFileAsync = promisify(execFile);

function appendDecisionLog(event, decision) {
  try {
    const line = JSON.stringify({
      timestamp: event.received_at,
      approver: APPROVER,
      rule: event.rule && event.rule.name,
      context: event.text,
      offending_text: event.offending_text,
      decision: decision.allow ? 'approve' : 'deny',
    }) + '\n';
    fs.appendFileSync(DECISIONS_LOG, line);
  } catch (error) {
    console.error('failed to append user_decisions.jsonl:', error.message);
  }
}

app.use(express.json({ limit: process.env.HOOK_BODY_LIMIT || '25mb' }));

const events = [];
const maxEvents = Number(process.env.HOOK_MAX_EVENTS || 500);
const decisionCache = new Map();
const CACHE_TTL_MS = Number(process.env.HOOK_DECISION_CACHE_TTL_MS || 3600000);

let approvalChain = Promise.resolve();
function serializeApproval(fn) {
  const next = approvalChain.then(() => fn(), () => fn());
  approvalChain = next.catch(() => {});
  return next;
}

function cacheKey(event) {
  return `${event.rule && event.rule.name ? event.rule.name : ''}::${event.offending_text || ''}`;
}

function getCached(key) {
  const entry = decisionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    decisionCache.delete(key);
    return null;
  }
  return entry.decision;
}

function setCached(key, decision) {
  decisionCache.set(key, { decision, at: Date.now() });
}

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    approver: APPROVER,
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
    rule: req.body && req.body.rule,
    text: req.body && req.body.text,
    offending_text: req.body && req.body.offending_text,
  };
  events.push(event);
  while (events.length > maxEvents) events.shift();

  const key = cacheKey(event);
  let decision = getCached(key);
  let cached = Boolean(decision);
  if (!decision) {
    decision = await serializeApproval(async () => {
      const recheck = getCached(key);
      if (recheck) return recheck;
      const result = await approve(event);
      if (!result.error) {
        setCached(key, result);
        appendDecisionLog(event, result);
      }
      return result;
    });
  }
  event.decision = decision;
  event.cached = cached;

  console.log(JSON.stringify({
    received_at: event.received_at,
    approver: APPROVER,
    rule: event.rule && event.rule.name,
    offending_text: event.offending_text,
    allowed: decision.allow,
    cached,
    comments: decision.comments,
    error: decision.error,
  }));

  if (!decision.allow) {
    return res.status(403).json(decision);
  }

  res.json(decision);
});

async function approve(event) {
  switch (APPROVER) {
    case 'touchid':
      return approveTouchID(event);
    case 'voice':
      return approveVoice(event);
    case 'local_voice':
      return approveLocalVoice(event);
    case 'approve':
      return approveAlways(event);
    case 'deny':
    default:
      return approveDeny(event);
  }
}

function approveDeny() {
  return {
    allow: false,
    redaction: REDACTION,
    reason: 'always-deny default policy',
    comments: 'always-deny default policy',
  };
}

function approveAlways() {
  return {
    allow: true,
    comments: 'always-approve policy',
  };
}

async function approveTouchID(event) {
  const prompt = buildTouchIDPrompt(event);
  try {
    const { command, args, cwd } = touchIDCommand(prompt);
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: TOUCHID_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const response = parseJsonOutput(stdout);
    if (response.confirmed === true) {
      return { allow: true, confirmed: true, comments: 'Touch ID confirmed' };
    }
    return {
      allow: false,
      confirmed: false,
      redaction: REDACTION,
      reason: response.error || 'Touch ID was not confirmed',
      comments: response.error || 'Touch ID was not confirmed',
    };
  } catch (error) {
    const response = parseJsonOutput(error.stdout);
    const message = response.error || error.message || 'Touch ID failed';
    return {
      allow: false,
      confirmed: false,
      redaction: REDACTION,
      reason: message,
      comments: message,
      error: message,
    };
  }
}

async function approveVoice(event) {
  try {
    const result = await approveByVoice(event);
    if (result.decision === 'approve') {
      return { allow: true, comments: result.reason || 'voice approved' };
    }
    return {
      allow: false,
      redaction: REDACTION,
      reason: result.reason || 'voice denied',
      comments: result.reason || 'voice denied',
    };
  } catch (error) {
    return {
      allow: false,
      redaction: REDACTION,
      reason: error.message || 'voice approver failed',
      comments: error.message || 'voice approver failed',
      error: error.message || 'voice approver failed',
    };
  }
}

async function approveLocalVoice(event) {
  try {
    const result = await approveByLocalVoice(event);
    const base = {
      surfaced_prompt: result.surfaced_prompt,
      transcript: result.transcript,
    };
    if (result.decision === 'approve') {
      return { allow: true, comments: result.reason || 'local voice approved', ...base };
    }
    return {
      allow: false,
      redaction: REDACTION,
      reason: result.reason || 'local voice denied',
      comments: result.reason || 'local voice denied',
      ...base,
    };
  } catch (error) {
    return {
      allow: false,
      redaction: REDACTION,
      reason: error.message || 'local voice approver failed',
      comments: error.message || 'local voice approver failed',
      error: error.message || 'local voice approver failed',
    };
  }
}

function buildTouchIDPrompt(event) {
  const rule = event.rule && event.rule.name ? event.rule.name : 'unnamed rule';
  const offending = truncate(stringOrEmpty(event.offending_text), 80);
  return truncate(`${rule}: ${offending}`, TOUCHID_REASON_CHARS);
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

function parseJsonOutput(output) {
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
    console.log(`llm-proxy hook server running on http://localhost:${port} (approver=${APPROVER})`);
  });
}

if (require.main === module) {
  startHookServer();
}

module.exports = {
  app,
  startHookServer,
};
