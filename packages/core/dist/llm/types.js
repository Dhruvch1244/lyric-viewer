"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
