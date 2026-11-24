import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SafeMarkdown, { normalizeUntrustedMarkdown } from "./SafeMarkdown";
import { escapeUntrustedHTML } from "../lib/trustedTypes";

describe("ZV-130 untrusted user-content rendering", () => {
  it.each([
    "<script>alert(1)</script>",
    "<svg onload=alert(1)>",
    '<img src=x onerror=alert(1)>',
    "[click](javascript:alert(1))",
    "[click](data:text/html,evil)",
    "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
  ])("neutralizes XSS payload %s", (payload) => {
    const { container } = render(<SafeMarkdown source={payload} />);
    expect(container.querySelector("script,svg,img,iframe")).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror=|onload=|javascript:|data:text\/html/i);
  });

  it("removes bidi overrides but preserves normal RTL words", () => {
    const text = "שלום\u202Eexample.com\u202C";
    expect(normalizeUntrustedMarkdown(text)).toBe("שלוםexample.com");
    const { container } = render(<SafeMarkdown source={text} />);
    expect(container.textContent).toContain("שלום");
    expect(container.textContent).not.toContain("\u202E");
  });

  it("escapes raw HTML when a TrustedHTML consumer explicitly requests it", () => {
    expect(escapeUntrustedHTML('<img src="x">&')).toBe('&lt;img src=&quot;x&quot;&gt;&amp;');
  });
});
