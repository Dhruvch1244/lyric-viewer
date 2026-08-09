'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { callGemini: coreCallGemini } = require('@lyric-viewer/core');

/**
 * Provider-neutral LLM layer for structured (JSON) text conversion.
 *
 * Used by transliteration (script conversion) and translation (English). The
 * provider is chosen by which credential is present, so a free Gemini key works
 * exactly like an Anthropic key with no code change at the call sites.
 *
 * Precedence: Gemini (if GEMINI_API_KEY) → Claude (if Anthropic creds) → none.
 * Override with LYRIC_OVERLAY_PROVIDER=gemini|claude.
 *
 * SECURITY: credentials are read from the environment only. Never hardcode a key.
 */

const GEMINI_MODEL = process.env.LYRIC_OVERLAY_GEMINI_MODEL || 'gemini-flash-latest';
const CLAUDE_MODEL = process.env.LYRIC_OVERLAY_MODEL || 'claude-opus-5';

/** @returns {boolean} */
function hasGemini() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

/**
 * Anthropic credentials may live in an env var or an `ant auth login` profile.
 * @returns {boolean}
 */
function hasClaude() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
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
 * @returns {'gemini'|'claude'|null} The active provider.
 */
function activeProvider() {
  const forced = (process.env.LYRIC_OVERLAY_PROVIDER || '').toLowerCase();
  if (forced === 'gemini') return hasGemini() ? 'gemini' : null;
  if (forced === 'claude') return hasClaude() ? 'claude' : null;
  if (hasGemini()) return 'gemini';
  if (hasClaude()) return 'claude';
  return null;
}

/** @returns {boolean} Whether any provider is configured. */
function isLLMAvailable() {
  return activeProvider() !== null;
}

/**
 * Call Gemini with a structured-output schema and return the parsed object.
 * The request/response handling itself lives in packages/core (shared with
 * the iOS app's on-device-first/cloud-fallback chain); this just supplies
 * the Electron-specific API key lookup.
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {object} args.schema JSON Schema (draft form).
 * @returns {Promise<object>}
 */
async function callGemini({ system, user, schema }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return coreCallGemini({ system, user, schema }, apiKey, GEMINI_MODEL);
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
  if (provider === 'claude') return callClaude({ system, user, schema });
  throw new Error('No LLM provider configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY.');
}

module.exports = { convert, isLLMAvailable, activeProvider };
