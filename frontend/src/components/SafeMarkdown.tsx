import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import rehypeExternalLinks from "rehype-external-links";
import { markdownSanitizeSchema } from "../lib/markdownSanitizeSchema";

/**
 * Single render path for untrusted IPFS Markdown (ZV-130).
 * Never render Markdown through raw HTML or `dangerouslySetInnerHTML`.
 * React creates elements, rehype-sanitize restricts tags/attributes/URLs,
 * and bidi controls are removed before the parser sees the input.
 */
export function normalizeUntrustedMarkdown(source: string): string {
  return source.normalize("NFC").replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
}

export default function SafeMarkdown({ source }: { source: string }) {
  return (
    <div dir="auto" className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeSanitize, markdownSanitizeSchema],
          [rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] }],
        ]}
      >
        {normalizeUntrustedMarkdown(source)}
      </ReactMarkdown>
    </div>
  );
}
