/**
 * Trusted Types bootstrap (ZV-130).
 * Raw HTML/script/script-URL passthrough default policies are unsafe: an
 * attacker who reaches an injection sink would bypass CSP enforcement.
 *
 * Render user Markdown with SafeMarkdown (React elements + rehype-sanitize).
 * The only exported policy here is a text-escaping policy for integrations
 * requiring a TrustedHTML object; it cannot turn untrusted HTML into markup.
 */
declare global {
  interface Window {
    trustedTypes?: {
      createPolicy: (name: string, rules: { createHTML: (text: string) => string }) => unknown;
    };
  }
}

export function escapeUntrustedHTML(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    const replacements: Record<string, string> = {
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;",
    };
    return replacements[char];
  });
}

export function initTrustedTypes(): void {
  if (typeof window !== "undefined" && window.trustedTypes) {
    try {
      // Explicit policy only; no permissive "default" policy. A raw DOM
      // injection remains blocked under require-trusted-types-for 'script'.
      window.trustedTypes.createPolicy("zkvote-escaped-text", {
        createHTML: escapeUntrustedHTML,
      });
    } catch {
      // Already registered, or CSP did not allow the named policy.
    }
  }
}

initTrustedTypes();
