'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Centralised API-key resolver.
 *
 * The original design read credentials from `process.env` only. That works for
 * `npm start` in a shell, but a double-clicked packaged build inherits no such
 * environment, so every LLM feature (translation, transliteration, mood) was
 * silently dead in the installed app. This resolver fixes that by layering three
 * sources, highest precedence first:
 *
 *   1. process.env                — power users / CI still win here
 *   2. userData/settings.json     — keys the user typed into the in-app 🔑 panel
 *   3. ./secrets.js (gitignored)  — a shipped default so the installer "just works"
 *
 * The secrets file is intentionally excluded from version control (see
 * .gitignore) but IS bundled into the packaged app, so the key travels with the
 * installer without ever landing in the repo.
 */

/** @type {Record<string, string>} */
let seed = {};
try {
  // eslint-disable-next-line global-require
  seed = require('./secrets') || {};
} catch {
  // No shipped secret — env or the in-app panel must supply the key.
}

/**
 * Read the `apiKeys` map persisted by the Settings store, fresh each call so a
 * key saved in the UI takes effect immediately without a restart.
 * @returns {Record<string, string>}
 */
function settingsKeys() {
  try {
    const file = path.join(app.getPath('userData'), 'settings.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data && data.apiKeys) || {};
  } catch {
    return {};
  }
}

/**
 * Resolve the first non-empty value across all sources for any of the given
 * environment-variable names (aliases).
 * @param {...string} names Candidate key names, in preference order.
 * @returns {string} The resolved key, or '' when none is configured.
 */
function getKey(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  const fromSettings = settingsKeys();
  for (const name of names) {
    const v = fromSettings[name];
    if (v && String(v).trim()) return String(v).trim();
  }
  for (const name of names) {
    const v = seed[name];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

/**
 * Persist an API key to userData/settings.json under `apiKeys[name]`.
 * Kept here (rather than on the Settings class) so the resolver owns the schema.
 * @param {string} name Canonical key name, e.g. 'HF_API_KEY'.
 * @param {string} value The key; an empty/blank value clears it.
 */
function setKey(name, value) {
  const file = path.join(app.getPath('userData'), 'settings.json');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }
  const apiKeys = { ...(data.apiKeys || {}) };
  if (value && String(value).trim()) apiKeys[name] = String(value).trim();
  else delete apiKeys[name];
  data.apiKeys = apiKeys;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { getKey, setKey };
