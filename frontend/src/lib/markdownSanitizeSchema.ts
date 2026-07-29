import { defaultSchema } from "rehype-sanitize";

/**
 * Custom schema for rehype-sanitize to prevent Stored XSS from Markdown content.
 * 
 * Design decisions:
 * - Allow-list approach: Only permits explicitly allowed tags.
 * - Event handlers (on*): Stripped automatically by defaultSchema when extending.
 * - Protocols: Limits href and src to http, https, and mailto.
 * - Images (img): Excluded by default as they are not in the explicit allow-list. 
 *   Allowing images from untrusted sources could lead to tracking pixels or 
 *   other unintended side-effects. If images are required later, they should
 *   be carefully reviewed and added to tagNames.
 */
export const markdownSanitizeSchema = {
  ...defaultSchema,
  // Exclude script, iframe, object, embed, form, style, img
  tagNames: [
    "p", "b", "i", "strong", "em", "a", "ul", "ol", "li",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
    "code", "pre", "br", "hr"
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Provide explicit attributes for a tag
    a: [
      ...(defaultSchema.attributes?.a || []),
      "href", "title"
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  }
};
