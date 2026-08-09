/**
 * Provider-neutral LLM contract shared by every feature that needs
 * structured (JSON) text conversion — transliteration, translation, and
 * sentiment/mood analysis.
 *
 * Deliberately does NOT decide *which* provider runs or *where credentials
 * come from* — that's platform-specific (env vars + `@anthropic-ai/sdk` on
 * Electron; an on-device-first, cloud-fallback chain on iOS per the
 * cross-platform plan's Phase 3). Each platform supplies a `Convert`
 * implementation; the prompt/schema/batching logic here stays identical.
 */

/** Minimal JSON-Schema-draft-shaped object, enough for our structured outputs. */
export type JsonSchema = Record<string, unknown>;

export interface ConvertArgs {
  system: string;
  user: string;
  schema: JsonSchema;
}

/** Runs one structured JSON conversion on whichever provider is configured. */
export type Convert = (args: ConvertArgs) => Promise<Record<string, unknown>>;
