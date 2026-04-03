const test = require('node:test');
const assert = require('node:assert/strict');
const { getProvider, complete } = require('../../src/inference/provider');

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('getProvider returns the configured provider', () => {
  const snapshot = {
    INFERENCE_PROVIDER: process.env.INFERENCE_PROVIDER
  };

  process.env.INFERENCE_PROVIDER = 'openai';
  assert.equal(getProvider(), 'openai');
  restoreEnv(snapshot);
});

test('getProvider throws for unsupported providers', () => {
  const snapshot = {
    INFERENCE_PROVIDER: process.env.INFERENCE_PROVIDER
  };

  process.env.INFERENCE_PROVIDER = 'invalid-provider';
  assert.throws(() => getProvider(), /Unsupported inference provider: invalid-provider/);
  restoreEnv(snapshot);
});

test('complete throws a clear error when Claude is selected without an API key', async () => {
  const snapshot = {
    INFERENCE_PROVIDER: process.env.INFERENCE_PROVIDER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
  };

  process.env.INFERENCE_PROVIDER = 'claude';
  delete process.env.ANTHROPIC_API_KEY;

  await assert.rejects(
    () => complete('Test prompt'),
    /ANTHROPIC_API_KEY is required when INFERENCE_PROVIDER=claude/
  );

  restoreEnv(snapshot);
});

test('complete throws a clear error when OpenAI is selected without an API key', async () => {
  const snapshot = {
    INFERENCE_PROVIDER: process.env.INFERENCE_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };

  process.env.INFERENCE_PROVIDER = 'openai';
  delete process.env.OPENAI_API_KEY;

  await assert.rejects(
    () => complete('Test prompt'),
    /OPENAI_API_KEY is required when INFERENCE_PROVIDER=openai/
  );

  restoreEnv(snapshot);
});

test('complete attempts Ollama connectivity and fails gracefully when unreachable', async () => {
  const snapshot = {
    INFERENCE_PROVIDER: process.env.INFERENCE_PROVIDER,
    OLLAMA_HOST: process.env.OLLAMA_HOST
  };

  process.env.INFERENCE_PROVIDER = 'ollama';
  process.env.OLLAMA_HOST = 'http://127.0.0.1:65500';

  await assert.rejects(
    () => complete('Test prompt'),
    /Unable to reach Ollama at http:\/\/127\.0\.0\.1:65500/
  );

  restoreEnv(snapshot);
});
