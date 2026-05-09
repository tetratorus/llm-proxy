const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LMSTUDIO_BASE_URL = (process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL || 'google/gemma-4-26b-a4b';
const ELEVENLABS_BASE_URL = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/$/, '');
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'CwhRBWXzGAHq8TQ4Fs17';
const ELEVENLABS_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const INPUT_RATE = Number(process.env.VOICE_INPUT_RATE || 16000);
const RECORD_MAX_MS = Number(process.env.ELEVENLABS_RECORD_MAX_MS || 30000);
const RECORD_PRE_SPEECH_MS = Number(process.env.ELEVENLABS_RECORD_PRE_SPEECH_MS || 8000);
const RECORD_SILENCE_MS = Number(process.env.ELEVENLABS_RECORD_SILENCE_MS || 1500);
const RECORD_SILENCE_THRESHOLD = Number(process.env.ELEVENLABS_RECORD_SILENCE_THRESHOLD || 0.015);
const CONTEXT_CHARS = Number(process.env.VOICE_CONTEXT_CHARS || 4000);

const SURFACE_SYSTEM = (
  'You are a security approval gateway sitting in front of an LLM proxy. The user '
  + 'message is JSON with `rule`, `offending_text`, and `text`, exactly as sent to '
  + 'the voice approval layer. Write the short spoken prompt that should be surfaced '
  + 'to the human. Briefly explain what was flagged and why it might be sensitive, '
  + 'without reading long secrets verbatim. Translate rule names and regexes into '
  + 'plain language. Use one or two short sentences. Always end with exactly: '
  + 'Do you approve or deny?'
);

const DECISION_SYSTEM = (
  'You are deciding a voice approval request. You will receive the original policy '
  + 'event JSON, the spoken prompt, and the user transcript. Return only approve or '
  + 'deny. If the transcript contains a denial, uncertainty, cancellation, or no clear '
  + 'approval, return deny. Otherwise return approve.'
);

async function approveByLocalVoice(event) {
  const policyEvent = {
    rule: (event && event.rule) || { name: 'unnamed-rule' },
    offending_text: (event && event.offending_text) || '',
    text: truncateForVoice((event && event.text) || ''),
  };

  const surfacedPrompt = await generateSurfacedPrompt(policyEvent);
  console.log(`[local-voice prompt] ${surfacedPrompt}`);

  const speech = await elevenLabsTts(surfacedPrompt);
  await playAudioFile(speech, '.mp3');

  console.log('[local-voice listening for approval reply...]');
  const wav = await recordUntilSilence();
  const transcript = await elevenLabsStt(wav);
  console.log(`[local-voice transcript] ${transcript}`);

  const value = await decideWithLmStudio(policyEvent, surfacedPrompt, transcript);
  const decision = value === 'approve' ? 'approve' : 'deny';
  await speakConfirmation(decision === 'approve' ? 'approved' : 'denied');

  return {
    decision,
    reason: decision === 'approve' ? 'voice approved' : 'voice denied',
    surfaced_prompt: surfacedPrompt,
    transcript,
  };
}

async function generateSurfacedPrompt(policyEvent) {
  const content = await lmStudioChat([
    { role: 'system', content: SURFACE_SYSTEM },
    { role: 'user', content: JSON.stringify(policyEvent) },
  ], { temperature: 0.2, max_tokens: 8192 });
  const prompt = content.trim().replace(/^["']|["']$/g, '');
  if (!prompt) throw new Error('LM Studio returned an empty surfaced prompt');
  return prompt;
}

async function decideWithLmStudio(policyEvent, surfacedPrompt, transcript) {
  const content = await lmStudioChat([
    { role: 'system', content: DECISION_SYSTEM },
    {
      role: 'user',
      content: JSON.stringify({
        policy_event: policyEvent,
        surfaced_prompt: surfacedPrompt,
        user_transcript: transcript,
      }),
    },
  ], { temperature: 0, max_tokens: 8192 });
  const text = content.trim().toLowerCase();
  if (/\bdeny\b|denied|reject|rejected|no\b/.test(text)) return 'deny';
  if (/\bapprove\b|approved|yes\b|allow\b/.test(text)) return 'approve';
  return 'deny';
}

async function lmStudioChat(messages, options) {
  const response = await fetch(`${LMSTUDIO_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: LMSTUDIO_MODEL,
      messages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`LM Studio ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  const content = data && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string') {
    throw new Error('LM Studio response did not include choices[0].message.content');
  }
  return content;
}

async function elevenLabsTts(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');
  const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      accept: 'audio/mpeg',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_TTS_MODEL,
    }),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs TTS ${response.status}: ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function elevenLabsStt(wav) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');
  const form = new FormData();
  form.append('model_id', ELEVENLABS_STT_MODEL);
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs STT ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  return String((data && data.text) || '').trim();
}

async function speakConfirmation(text) {
  try {
    const speech = await elevenLabsTts(text);
    await playAudioFile(speech, '.mp3');
  } catch (error) {
    console.error('failed to speak confirmation:', error.message);
  }
}

function recordUntilSilence() {
  return new Promise((resolve, reject) => {
    const mic = spawn('sox', [
      '-q',
      '-d',
      '-t', 'raw',
      '-r', String(INPUT_RATE),
      '-e', 'signed',
      '-b', '16',
      '-c', '1',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = [];
    let started = false;
    let silentMs = 0;
    let preSpeechMs = 0;
    let settled = false;
    let stderr = '';

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      try { mic.kill('SIGTERM'); } catch {}
      if (error) return reject(error);
      resolve(makeWav(Buffer.concat(chunks), INPUT_RATE));
    };

    const maxTimer = setTimeout(() => finish(), RECORD_MAX_MS);

    mic.stdout.on('data', chunk => {
      chunks.push(chunk);
      const durationMs = chunk.length / 2 / INPUT_RATE * 1000;
      const rms = pcmRms(chunk);
      if (rms > RECORD_SILENCE_THRESHOLD) {
        started = true;
        silentMs = 0;
      } else if (started) {
        silentMs += durationMs;
        if (silentMs >= RECORD_SILENCE_MS) finish();
      } else {
        preSpeechMs += durationMs;
        if (preSpeechMs >= RECORD_PRE_SPEECH_MS) finish();
      }
    });
    mic.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    mic.on('error', error => finish(error));
    mic.on('exit', code => {
      if (settled) return;
      if (code && chunks.length === 0) {
        finish(new Error(`sox microphone recording failed: ${stderr.trim() || `exit ${code}`}`));
      } else {
        finish();
      }
    });
  });
}

function pcmRms(chunk) {
  if (chunk.length < 2) return 0;
  let sum = 0;
  let samples = 0;
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const sample = chunk.readInt16LE(i) / 32768;
    sum += sample * sample;
    samples += 1;
  }
  return Math.sqrt(sum / Math.max(samples, 1));
}

function playAudioFile(bytes, suffix) {
  return new Promise(resolve => {
    const tmpPath = path.join(os.tmpdir(), `local-voice-${process.pid}-${Date.now()}${suffix}`);
    fs.writeFileSync(tmpPath, bytes);
    const proc = spawn('afplay', [tmpPath], { stdio: 'ignore' });
    const cleanup = () => {
      try { fs.unlinkSync(tmpPath); } catch {}
      resolve();
    };
    proc.on('exit', cleanup);
    proc.on('error', cleanup);
  });
}

function truncateForVoice(value) {
  if (typeof value !== 'string' || value.length <= CONTEXT_CHARS) return value;
  return `${value.slice(0, CONTEXT_CHARS)}...[truncated ${value.length - CONTEXT_CHARS} chars]`;
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

module.exports = { approveByLocalVoice };
