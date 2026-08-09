'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getKey } = require('./keys');

/**
 * Provider-neutral LLM layer for structured (JSON) text conversion.
 *
 * Used by transliteration (script conversion) and translation (English). The
 * provider is chosen by which credential is present, so a free Gemini key works
 * exactly like an Anthropic key with no code change at the call sites.
 *
 * Precedence: Gemini → Groq → HuggingFace → Claude → none. Override with
 * LYRIC_OVERLAY_PROVIDER=gemini|groq|huggingface|claude.
 *
 * Credentials resolve through keys.js (env → in-app 🔑 panel → shipped secret),
 * so the LLM features work in the packaged installer, not just a dev shell.
 *
 * Groq offers a generous free tier (fast Llama/GPT-OSS models) and is an ideal
 * fallback when the Gemini free quota is exhausted — get a key at
 * https://console.groq.com/keys and set GROQ_API_KEY.
 *
 * HuggingFace uses the OpenAI-compatible Inference-Providers router
 * (https://router.huggingface.co/v1) — set HF_API_KEY (a fine-grained token with
 * "Make calls to Inference Providers" permission).
 */

const GEMINI_MODEL = process.env.LYRIC_OVERLAY_GEMINI_MODEL || 'gemini-flash-latest';
const GROQ_MODEL = process.env.LYRIC_OVERLAY_GROQ_MODEL || 'llama-3.3-70b-versatile';
const HF_MODEL = process.env.LYRIC_OVERLAY_HF_MODEL || 'meta-llama/Llama-3.3-70B-Instruct';
const CLAUDE_MODEL = process.env.LYRIC_OVERLAY_MODEL || 'claude-opus-5';

/** @returns {string} The resolved Gemini key, or ''. */
function geminiKey() {
  return getKey('GEMINI_API_KEY', 'GOOGLE_API_KEY');
}

/** @returns {string} The resolved Groq key, or ''. */
function groqKey() {
  return getKey('GROQ_API_KEY');
}

/** @returns {string} The resolved HuggingFace token, or ''. */
function hfKey() {
  return getKey('HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN');
}

/** @returns {boolean} */
function hasGemini() {
  return Boolean(geminiKey());
}

/** @returns {boolean} */
function hasGroq() {
  return Boolean(groqKey());
}

/** @returns {boolean} */
function hasHuggingFace() {
  return Boolean(hfKey());
}

/**
 * Anthropic credentials may live in an env var, the in-app panel, or an
 * `ant auth login` profile.
 * @returns {boolean}
 */
function hasClaude() {
  if (getKey('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')) return true;
  const configDir =
    process.env.ANTHROPIC_CONFIG_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'Anthropic')
      : path.join(os.homedir(), '.config', 'anthropic'));
  try {
    return fs.existsSync(path.join(configDir, 'credentials'));
  } catch {
    return false;
  }
}

/**
 * @returns {'gemini'|'groq'|'huggingface'|'claude'|null} The active provider.
 */
function activeProvider() {
  const forced = (process.env.LYRIC_OVERLAY_PROVIDER || '').toLowerCase();
  if (forced === 'gemini') return hasGemini() ? 'gemini' : null;
  if (forced === 'groq') return hasGroq() ? 'groq' : null;
  if (forced === 'huggingface' || forced === 'hf') return hasHuggingFace() ? 'huggingface' : null;
  if (forced === 'claude') return hasClaude() ? 'claude' : null;
  if (hasGemini()) return 'gemini';
  if (hasGroq()) return 'groq';
  if (hasHuggingFace()) return 'huggingface';
  if (hasClaude()) return 'claude';
  return null;
}

/** @returns {boolean} Whether any provider is configured. */
function isLLMAvailable() {
  return activeProvider() !== null;
}

/**
 * Convert a JSON Schema (draft form) into Gemini's responseSchema dialect:
 * uppercase type names, and drop keys Gemini rejects (additionalProperties).
 * @param {object} schema
 * @returns {object}
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)])
      );
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Call Gemini with a structured-output schema and return the parsed object.
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {object} args.schema JSON Schema (draft form).
 * @returns {Promise<object>}
 */
async function callGemini({ system, user, schema }) {
  const apiKey = geminiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini responded ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = await response.json();

  const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
  if (blockReason) throw new Error(`Gemini blocked the request (${blockReason}).`);

  const candidate = data.candidates && data.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map((p) => p.text || '').join('')
    : '';
  if (!text) throw new Error('Empty response from Gemini.');

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Gemini returned unparseable JSON.');
  }
}

/**
 * Call Groq (OpenAI-compatible Chat Completions) and return the parsed object.
 *
 * Groq's JSON mode guarantees syntactically valid JSON but does not enforce the
 * schema, so the schema is described in the system prompt and the call sites
 * validate shape (e.g. line counts) themselves.
 *
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {object} args.schema JSON Schema (draft form).
 * @returns {Promise<object>}
 */
async function callGroq({ system, user, schema }) {
  const apiKey = groqKey();
  const url = 'https://api.groq.com/openai/v1/chat/completions';

  const body = {
    model: GROQ_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `${system}\n\nReturn ONLY a JSON object that conforms to this JSON Schema ` +
          `(no markdown, no commentary):\n${JSON.stringify(schema)}`,
      },
      { role: 'user', content: user },
    ],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Groq responded ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content || ''
    : '';
  if (!text) throw new Error('Empty response from Groq.');

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Groq returned unparseable JSON.');
  }
}

/**
 * Best-effort JSON extraction from a chat completion that may wrap the object in
 * prose or a ```json fence (HF providers don't uniformly honour json_object).
 * @param {string} text
 * @returns {object}
 */
function parseJsonLoose(text) {
  const trimmed = (text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Strip a leading/trailing markdown fence, then grab the outermost braces.
    const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1));
    }
    throw new Error('HuggingFace returned unparseable JSON.');
  }
}

/**
 * Call HuggingFace via the OpenAI-compatible Inference-Providers router and
 * return the parsed object. The schema is described in the system prompt (the
 * router does not enforce a response schema), and the call sites validate shape.
 *
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {object} args.schema JSON Schema (draft form).
 * @returns {Promise<object>}
 */
async function callHuggingFace({ system, user, schema }) {
  const apiKey = hfKey();
  const url = 'https://router.huggingface.co/v1/chat/completions';

  const body = {
    model: HF_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `${system}\n\nReturn ONLY a JSON object that conforms to this JSON Schema ` +
          `(no markdown, no commentary):\n${JSON.stringify(schema)}`,
      },
      { role: 'user', content: user },
    ],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`HuggingFace responded ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content || ''
    : '';
  if (!text) throw new Error('Empty response from HuggingFace.');
  return parseJsonLoose(text);
}

/**
 * Call Claude with a structured-output schema and return the parsed object.
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {object} args.schema JSON Schema (draft form).
 * @returns {Promise<object>}
 */
async function callClaude({ system, user, schema }) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    throw new Error('@anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk');
  }
  const Ctor = Anthropic.default || Anthropic;
  const client = new Ctor();

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Request was declined by the model.');
  }
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('Empty response from Claude.');
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error('Claude returned unparseable JSON.');
  }
}

/**
 * Run a structured JSON conversion on whichever provider is configured.
 * @param {object} args
 * @param {string} args.system System prompt.
 * @param {string} args.user User content.
 * @param {object} args.schema JSON Schema (draft form) describing the output.
 * @returns {Promise<object>} Parsed JSON matching the schema.
 */
async function convert({ system, user, schema }) {
  const provider = activeProvider();
  if (provider === 'gemini') return callGemini({ system, user, schema });
  if (provider === 'groq') return callGroq({ system, user, schema });
  if (provider === 'huggingface') return callHuggingFace({ system, user, schema });
  if (provider === 'claude') return callClaude({ system, user, schema });
  throw new Error('No LLM provider configured. Set GEMINI_API_KEY, GROQ_API_KEY, HF_API_KEY, or ANTHROPIC_API_KEY.');
}

module.exports = { convert, isLLMAvailable, activeProvider };
