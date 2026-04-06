const path = require('path');
const dotenv = require('dotenv');
const Anthropic = require('@anthropic-ai/sdk');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const SUPPORTED_PROVIDERS = new Set(['claude', 'ollama', 'openai']);

let _anthropicClient = null;

function getAnthropicClient() {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic();
  }
  return _anthropicClient;
}

function getProvider() {
  const provider = String(process.env.INFERENCE_PROVIDER || 'claude')
    .trim()
    .toLowerCase();

  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported inference provider: ${provider}`);
  }

  return provider;
}

function getOllamaHost() {
  return process.env.OLLAMA_HOST || 'http://localhost:11434';
}

async function ensureProviderConfigured() {
  const provider = getProvider();

  if (provider === 'claude') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required when INFERENCE_PROVIDER=claude');
    }

    return provider;
  }

  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when INFERENCE_PROVIDER=openai');
    }

    return provider;
  }

  const ollamaHost = getOllamaHost();
  const baseUrl = ollamaHost.endsWith('/') ? ollamaHost : `${ollamaHost}/`;
  const probeUrl = new URL('api/tags', baseUrl).toString();

  try {
    const response = await fetch(probeUrl, { signal: AbortSignal.timeout(2000) });

    if (!response.ok) {
      throw new Error('probe failed');
    }
  } catch (_error) {
    throw new Error(`Unable to reach Ollama at ${ollamaHost}`);
  }

  return provider;
}

function getScaffoldMessage(provider) {
  if (provider === 'claude') {
    return 'Claude provider scaffold is not implemented in Module 1';
  }

  if (provider === 'openai') {
    return 'OpenAI provider scaffold is not implemented in Module 1';
  }

  return 'Ollama provider scaffold is not implemented in Module 1';
}

async function complete(prompt, options = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('prompt must be a non-empty string');
  }

  const provider = await ensureProviderConfigured();

  if (provider === 'claude') {
    const client = getAnthropicClient();
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const maxTokens = options.maxTokens || 2048;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return text;
  }

  throw new Error(getScaffoldMessage(provider));
}

async function embed(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('text must be a non-empty string');
  }

  const provider = await ensureProviderConfigured();
  throw new Error(getScaffoldMessage(provider));
}

module.exports = {
  complete,
  embed,
  getProvider
};
