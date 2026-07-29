import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import rehypeExternalLinks from "rehype-external-links";
import { markdownSanitizeSchema } from "./markdownSanitizeSchema";

const renderMarkdown = (markdown: string) => {
  const { container } = render(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[
        [rehypeSanitize, markdownSanitizeSchema],
        [rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] }],
      ]}
    >
      {markdown}
    </ReactMarkdown>
  );
  return container.innerHTML;
};

describe("Markdown Sanitization Pipeline", () => {
  it("strips basic script tags", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  it("strips case/whitespace script variants", () => {
    const html1 = renderMarkdown("<ScRipT>alert(1)</ScRipT>");
    const html2 = renderMarkdown("<script >alert(1)</script>");
    expect(html1).not.toContain("<script");
    expect(html2).not.toContain("<script");
  });

  it("strips image tags and onerror handlers", () => {
    const html = renderMarkdown("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });

  it("strips javascript: protocol from links", () => {
    const html = renderMarkdown('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("strips svg and onload handlers", () => {
    const html = renderMarkdown("<svg onload=alert(1)>");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("onload");
  });

  it("strips iframe tags", () => {
    const html = renderMarkdown('<iframe src="javascript:alert(1)">');
    expect(html).not.toContain("<iframe");
  });

  it("handles encoded/obfuscated variants", () => {
    const html = renderMarkdown("<a href=\"&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A&#x61&#x6C&#x65&#x72&#x74&#x28&#x27&#x58&#x53&#x53&#x27&#x29\">click</a>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("alert");
  });

  it("strips leading whitespace bypass attempts in href", () => {
    const html = renderMarkdown('<a href="  javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript:");
  });

  it("strips malformed/broken tags intended to confuse parsers", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)" ');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toContain("<img");
  });

  it("strips markdown-native injection", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("strips form, object, and embed tags", () => {
    const html = renderMarkdown("<form><object><embed></embed></object></form>");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<embed");
  });

  it("allows legitimate Markdown to render correctly", () => {
    const markdown = `
# Heading 1
## Heading 2
**bold** and *italic*
> blockquote
- list item
\`code\`

\`\`\`
pre
\`\`\`
    `;
    const html = renderMarkdown(markdown);
    expect(html).toContain("<h1>Heading 1</h1>");
    expect(html).toContain("<h2>Heading 2</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<li>list item");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<pre>");
  });

  it("forces rel='noopener noreferrer' and target='_blank' on legitimate https links", () => {
    const html = renderMarkdown("[legit link](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("regression test: https link without rel/target gets them added in source Markdown", () => {
    const html = renderMarkdown("[HTML link](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
