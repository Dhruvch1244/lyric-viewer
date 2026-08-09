"use strict";
/**
 * Gemini structured-output call, via the global `fetch` — available in
 * Electron's Node runtime and in React Native, so this needs no
 * platform-specific HTTP client or SDK. Ported from src/main/llm.js.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toGeminiSchema = toGeminiSchema;
exports.callGemini = callGemini;
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
/**
 * Convert a JSON Schema (draft form) into Gemini's responseSchema dialect:
 * uppercase type names, and drop keys Gemini rejects (additionalProperties).
 */
function toGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object')
        return schema;
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'additionalProperties')
            continue;
        if (key === 'type' && typeof value === 'string') {
            out.type = value.toUpperCase();
        }
        else if (key === 'properties' && value && typeof value === 'object') {
            out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
        }
        else if (key === 'items') {
            out.items = toGeminiSchema(value);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
/** Call Gemini with a structured-output schema and return the parsed object. */
async function callGemini({ system, user, schema }, apiKey, model = DEFAULT_GEMINI_MODEL) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
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
        signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Gemini responded ${response.status}: ${detail.slice(0, 200)}`);
    }
    const data = await response.json();
    const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
    if (blockReason)
        throw new Error(`Gemini blocked the request (${blockReason}).`);
    const candidate = data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
        ? candidate.content.parts.map((p) => p.text || '').join('')
        : '';
    if (!text)
        throw new Error('Empty response from Gemini.');
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error('Gemini returned unparseable JSON.');
    }
}
