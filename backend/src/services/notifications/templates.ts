/**
 * Notification templates (ZV-037 / #886).
 *
 * Every value that can come from a user (DAO names, proposal titles, dispute
 * resolutions) is HTML-escaped in the HTML body, and Stellar account and
 * contract addresses are redacted from every part of every message: a
 * notification must never tie a destination to a wallet.
 */
import type { NotificationEvent, RenderedMessage } from "./types.js";

/** Stellar account (G…), muxed (M…) and contract (C…) strkeys. */
const STELLAR_ADDRESS = /\b[GCM][A-Z2-7]{55}(?:[A-Z2-7]{13})?\b/g;
export const REDACTED_ADDRESS = "[address hidden]";

export function redactAddresses(value: string): string {
  return value.replace(STELLAR_ADDRESS, REDACTED_ADDRESS);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text for a user-supplied value: redacted, single line, bounded. */
function clean(value: unknown, fallback: string, max = 200): string {
  if (value === null || value === undefined || value === "") return fallback;
  // Control characters (newlines, NUL, DEL) would break the single-line subject.
  const text = Array.from(redactAddresses(String(value)), (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || fallback;
}

function formatTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toUTCString();
}

export interface TemplateContext {
  /** Base URL of the app, e.g. https://vote.example.org */
  publicUrl: string;
  /** The subscriber's contact token, for the unsubscribe link. */
  token: string;
}

export function renderNotification(event: NotificationEvent, ctx: TemplateContext): RenderedMessage {
  const base = ctx.publicUrl.replace(/\/+$/, "");
  const dao = clean(event.data.daoName, event.daoId ? `DAO ${clean(event.daoId, "")}` : "your DAO", 80);
  const title = clean(event.data.proposalTitle, "an election");
  const when = formatTime(event.data.at);
  const unsubscribeUrl = `${base}/api/v1/notifications/unsubscribe?token=${encodeURIComponent(ctx.token)}`;
  const link = event.daoId ? `${base}/dao/${encodeURIComponent(clean(event.daoId, ""))}` : base;

  let subject: string;
  let lines: string[];
  switch (event.type) {
    case "election_started":
      subject = `Voting is open: ${title}`;
      lines = [`Voting has opened in ${dao} on "${title}".`, when ? `It closes ${when}.` : ""];
      break;
    case "election_ended":
      subject = `Voting has closed: ${title}`;
      lines = [`Voting has closed in ${dao} on "${title}".`, "Results are being tallied."];
      break;
    case "dispute_outcome":
      subject = `A dispute in ${dao} was resolved`;
      lines = [`A dispute in ${dao} was resolved.`, `Outcome: ${clean(event.data.outcome, "resolved", 500)}`];
      break;
    default: {
      const unreachable: never = event.type;
      throw new Error(`No template for ${String(unreachable)}`);
    }
  }
  lines = lines.filter(Boolean);
  subject = redactAddresses(subject);

  const footer = "You get this because you asked for ZK-VOTE notifications.";
  const text = [...lines, "", link, "", footer, `Unsubscribe: ${unsubscribeUrl}`].join("\n");
  const html = [
    "<!doctype html><html><body>",
    ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p><a href="${escapeHtml(link)}">Open ZK-VOTE</a></p>`,
    `<p style="color:#666;font-size:12px">${escapeHtml(footer)} `,
    `<a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`,
    "</body></html>",
  ].join("");

  return {
    subject,
    text,
    html,
    unsubscribeUrl,
    push: { title: subject, body: lines[0], url: link },
  };
}
