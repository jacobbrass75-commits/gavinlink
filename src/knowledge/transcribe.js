const fs = require('fs');
const path = require('path');
const { classifyMessage } = require('../ingestion/classifier');
const { routeClassifiedMessage } = require('../ingestion/router');

const AUDIO_MIME_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm'
};

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getTranscriptionProvider() {
  return String(process.env.TRANSCRIPTION_PROVIDER || 'openai').trim().toLowerCase();
}

function getMimeType(filePath) {
  return AUDIO_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function transcribeWithOpenAI(filePath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when TRANSCRIPTION_PROVIDER=openai');
  }

  const fileBuffer = await fs.promises.readFile(filePath);
  const file = new File([fileBuffer], path.basename(filePath), {
    type: getMimeType(filePath)
  });
  const form = new FormData();

  form.append('file', file);
  form.append('model', process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1');
  form.append('response_format', 'verbose_json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: form
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed with status ${response.status}`);
  }

  const payload = await response.json();

  return {
    text: cleanText(payload.text, ''),
    duration_seconds: Number.isFinite(Number(payload.duration)) ? Number(payload.duration) : 0,
    language: cleanText(payload.language, 'unknown')
  };
}

async function transcribeWithDeepgram(filePath) {
  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is required when TRANSCRIPTION_PROVIDER=deepgram');
  }

  const fileBuffer = await fs.promises.readFile(filePath);
  const response = await fetch(
    `${process.env.DEEPGRAM_URL || 'https://api.deepgram.com/v1/listen'}?model=nova-2&smart_format=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': getMimeType(filePath)
      },
      body: fileBuffer
    }
  );

  if (!response.ok) {
    throw new Error(`Deepgram transcription failed with status ${response.status}`);
  }

  const payload = await response.json();
  const alternative =
    payload.results?.channels?.[0]?.alternatives?.[0] ||
    payload.results?.utterances?.[0] ||
    null;

  return {
    text: cleanText(alternative?.transcript, ''),
    duration_seconds: Number.isFinite(Number(payload.metadata?.duration))
      ? Number(payload.metadata.duration)
      : 0,
    language: cleanText(payload.results?.channels?.[0]?.detected_language, 'unknown')
  };
}

async function transcribeAudio(filePath) {
  const absolutePath = path.resolve(filePath);

  try {
    await fs.promises.access(absolutePath, fs.constants.R_OK);
  } catch (_error) {
    throw new Error(`Audio file not found: ${absolutePath}`);
  }

  const provider = getTranscriptionProvider();

  if (provider === 'deepgram') {
    return transcribeWithDeepgram(absolutePath);
  }

  return transcribeWithOpenAI(absolutePath);
}

async function processAudioFile(filePath, options = {}) {
  const transcription = await transcribeAudio(filePath);
  const classified = await classifyMessage(transcription.text);
  const routed = await routeClassifiedMessage(classified, transcription.text, {
    ...options,
    source: options.source || 'voice_memo',
    source_file: path.resolve(filePath)
  });

  return {
    transcription,
    classified,
    ...routed
  };
}

module.exports = {
  transcribeAudio,
  processAudioFile
};
