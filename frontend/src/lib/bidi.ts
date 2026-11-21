/**
 * Bidirectional text utilities for RTL language support
 * Prevents bidi-override spoofing attacks and ensures safe rendering
 */

// Two regexes, not one: a global-flagged regex used with `.test()` keeps
// `lastIndex` between calls, so a prior match could make a later call on an
// unrelated string miss a real override (both must scan from 0 every time).
const BIDI_OVERRIDE_TEST = /[\u202A-\u202E\u2066-\u2069]/;
const BIDI_OVERRIDE_CHARS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Strip bidi override characters to prevent spoofing attacks
 */
export function stripBidiOverrides(text: string): string {
  return text.replace(BIDI_OVERRIDE_CHARS, "");
}

/**
 * Isolate user-generated content with bidi isolation
 * Wraps text in FSI...PDI for safe mixed-direction rendering
 */
export function isolateBidi(text: string): string {
  return `\u2068${text}\u2069`; // FSI...PDI
}

/**
 * Sanitize and isolate addresses/hashes for safe display
 */
export function sanitizeAddress(address: string): string {
  return isolateBidi(stripBidiOverrides(address));
}

/**
 * Check if text contains potentially malicious bidi characters
 */
export function hasBidiOverrides(text: string): boolean {
  return BIDI_OVERRIDE_TEST.test(text);
}
