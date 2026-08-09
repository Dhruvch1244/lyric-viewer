/**
 * Gemini structured-output call, via the global `fetch` — available in
 * Electron's Node runtime and in React Native, so this needs no
 * platform-specific HTTP client or SDK. Ported from src/main/llm.js.
 */
import type { ConvertArgs, JsonSchema } from './types';
/**
 * Convert a JSON Schema (draft form) into Gemini's responseSchema dialect:
 * uppercase type names, and drop keys Gemini rejects (additionalProperties).
 */
export declare function toGeminiSchema(schema: JsonSchema): JsonSchema;
/** Call Gemini with a structured-output schema and return the parsed object. */
export declare function callGemini({ system, user, schema }: ConvertArgs, apiKey: string, model?: string): Promise<Record<string, unknown>>;
