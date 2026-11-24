/**
 * Bidirectional text validation utilities
 * Prevents bidi-override spoofing attacks (Issue #792)
 */

const BIDI_OVERRIDE_TEST = /[\u202A-\u202E\u2066-\u2069]/;
const BIDI_OVERRIDE_CHARS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Check if text contains potentially malicious bidi override characters
 */
export function hasBidiOverrides(text: string): boolean {
  return BIDI_OVERRIDE_TEST.test(text);
}

/**
 * Strip bidi override characters to prevent spoofing attacks
 */
export function stripBidiOverrides(text: string): string {
  return text.replace(BIDI_OVERRIDE_CHARS, "");
}

/**
 * Validate that text doesn't contain bidi override characters
 * Returns true if text is safe
 */
export function validateBidiSafe(text: string): boolean {
  return !hasBidiOverrides(text);
}
