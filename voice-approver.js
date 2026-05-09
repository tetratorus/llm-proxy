const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const SETUP_TIMEOUT_MS = Number(process.env.VOICE_SETUP_TIMEOUT_MS || 20000);
const SPEAK_TIMEOUT_MS = Number(process.env.VOICE_SPEAK_TIMEOUT_MS || 60000);
const REPLY_TIMEOUT_MS = Number(process.env.VOICE_REPLY_TIMEOUT_MS || 60000);

const SYSTEM = (
  'You are a security approval gateway sitting in front of an LLM proxy. The first '
  + 'user message is JSON with three fields: `rule` (an object with `name`, `pattern`, '
  + 'and `flags` describing the policy rule that fired), `offending_text` (the exact '
  + 'substring that matched the rule), and `text` (the surrounding payload that was '
  + 'about to be sent upstream). '
  + 'Read the context, briefly explain to the listener in plain language what was '
  + 'flagged and why it might be sensitive, then ask whether to approve or deny '
  + 'sending it. Be specific about what kind of data was matched (API key, secret, '
  + 'risky shell command, PII, etc.) — the offending text is not always an API key. '
  + 'Do NOT read out long secret values verbatim; describe them (e.g. "an OpenAI '
  + 'key starting with sk-..."). Do NOT read the `rule.name` slug, the `rule.pattern` '
  + 'regex, or any of the dashes/underscores in the JSON keys out loud — translate '
  + 'them into natural language. Be very brief — one or two short sentences max, '
  + 'under five seconds of speech. No preamble. ALWAYS end your spoken prompt with '
  + 'the exact phrase "Do you approve or deny?" so the listener knows what to say. '
  + 'Then listen for their reply. As soon as you have their answer, FIRST say one '
  + 'short word out loud confirming the decision — exactly "approved" or "denied". '
  + "THEN call the `decide` tool with decision set to `approve` or `deny`. If their "
  + "reply contains 'deny', the decision is `deny`; otherwise `approve`."
);

const TOOL = {
  functionDeclarations: [
    {
      name: 'decide',
      description: "Submit the user's approval decision.",
      parameters: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['approve', 'deny'] },
          reason: { type: 'string' },
        },
        required: ['decision'],
      },
    },
  ],
};

async function approveByVoice(event) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const message = JSON.stringify({
    rule: (event && event.rule) || { name: 'unnamed-rule' },
    offending_text: (event && event.offending_text) || '',
    text: truncateForVoice((event && event.text) || ''),
  });
  const uri = 'wss://generativelanguage.googleapis.com/ws/'
    + 'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
    + `?key=${apiKey}`;

  const ws = new WebSocket(uri, { perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const reader = makeReader(ws);

  try {
    ws.send(JSON.stringify({
      setup: {
        model: `models/${MODEL}`,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: SYSTEM }] },
        tools: [TOOL],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }));

    const first = await reader.next(SETUP_TIMEOUT_MS);
    if (!first.setupComplete) {
      throw new Error(`expected setupComplete, got ${JSON.stringify(first).slice(0, 200)}`);
    }

    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: message }] }],
        turnComplete: true,
      },
    }));

    const audioChunks = [];
    const speakDeadline = Date.now() + SPEAK_TIMEOUT_MS;
    while (true) {
      const remaining = speakDeadline - Date.now();
      if (remaining <= 0) throw new Error('gemini did not finish speaking');
      const msg = await reader.next(remaining);
      const sc = msg.serverContent;
      if (!sc) continue;
      for (const part of (sc.modelTurn && sc.modelTurn.parts) || []) {
        if (part.inlineData && part.inlineData.data) {
          audioChunks.push(Buffer.from(part.inlineData.data, 'base64'));
        }
      }
      if (sc.turnComplete) break;
    }

    if (audioChunks.length) {
      await playPcm(Buffer.concat(audioChunks), OUTPUT_RATE);
    }

    const mic = startMic(INPUT_RATE);
    let micClosed = false;
    const stopMic = () => {
      if (micClosed) return;
      micClosed = true;
      try { mic.kill('SIGTERM'); } catch {}
    };

    mic.stdout.on('data', chunk => {
      if (micClosed) return;
      try {
        ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: `audio/pcm;rate=${INPUT_RATE}`,
              data: chunk.toString('base64'),
            },
          },
        }));
      } catch {}
    });
    mic.on('error', () => stopMic());

    const replyDeadline = Date.now() + REPLY_TIMEOUT_MS;
    let decision = null;
    let confirmTurnComplete = false;
    const confirmChunks = [];
    while (decision === null || !confirmTurnComplete) {
      const remaining = replyDeadline - Date.now();
      if (remaining <= 0) {
        stopMic();
        if (decision === null) throw new Error('timed out waiting for user reply');
        break;
      }
      const msg = await reader.next(remaining);
      const sc = msg.serverContent;
      if (sc) {
        for (const part of (sc.modelTurn && sc.modelTurn.parts) || []) {
          if (part.inlineData && part.inlineData.data) {
            confirmChunks.push(Buffer.from(part.inlineData.data, 'base64'));
          }
        }
        if (sc.turnComplete) confirmTurnComplete = true;
      }
      const tc = msg.toolCall;
      if (tc && Array.isArray(tc.functionCalls)) {
        for (const call of tc.functionCalls) {
          if (call.name === 'decide') {
            decision = call.args || {};
            ws.send(JSON.stringify({
              toolResponse: {
                functionResponses: [
                  { id: call.id, name: 'decide', response: { ok: true } },
                ],
              },
            }));
            stopMic();
          }
        }
      }
    }

    stopMic();
    const value = String(decision.decision || 'approve').toLowerCase();
    const finalDecision = value === 'deny' ? 'deny' : 'approve';
    if (confirmChunks.length) {
      await playPcm(Buffer.concat(confirmChunks), OUTPUT_RATE);
    } else {
      await say(finalDecision === 'approve' ? 'approved' : 'denied');
    }
    return { decision: finalDecision, reason: decision.reason || '' };
  } finally {
    try { ws.close(); } catch {}
  }
}

function makeReader(ws) {
  const queue = [];
  let waiter = null;
  let closed = false;
  let error = null;

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  ws.on('close', () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(new Error('websocket closed'));
    }
  });
  ws.on('error', err => {
    error = err;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(err);
    }
  });

  return {
    next(timeoutMs) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.reject(new Error('websocket closed'));
      if (error) return Promise.reject(error);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (waiter && waiter.resolve === settle) {
            waiter = null;
            reject(new Error('websocket message timeout'));
          }
        }, timeoutMs);
        const settle = msg => { clearTimeout(timer); resolve(msg); };
        const fail = err => { clearTimeout(timer); reject(err); };
        waiter = { resolve: settle, reject: fail };
      });
    },
  };
}

function startMic(sampleRate) {
  return spawn('sox', [
    '-q',
    '-d',
    '-t', 'raw',
    '-r', String(sampleRate),
    '-e', 'signed',
    '-b', '16',
    '-c', '1',
    '-',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
}

function say(text) {
  return new Promise(resolve => {
    const proc = spawn('say', [text], { stdio: 'ignore' });
    proc.on('exit', resolve);
    proc.on('error', resolve);
  });
}

function playPcm(pcm, sampleRate) {
  return new Promise((resolve) => {
    const wav = makeWav(pcm, sampleRate);
    const tmpPath = path.join(os.tmpdir(), `voice-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(tmpPath, wav);
    const proc = spawn('afplay', [tmpPath], { stdio: 'ignore' });
    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} resolve(); };
    proc.on('exit', cleanup);
    proc.on('error', cleanup);
  });
}

function truncateForVoice(value) {
  const limit = Number(process.env.VOICE_CONTEXT_CHARS || 4000);
  if (typeof value !== 'string' || value.length <= limit) return value;
  return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

function makeWav(pcm, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

module.exports = { approveByVoice };
