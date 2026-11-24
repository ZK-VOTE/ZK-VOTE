/**
 * ZV-128 — Versioned, localized proposal-template registry.
 * Source of truth: shared/proposal-template-registry.json. The generated
 * frontend/backend snapshots are compared in CI to prevent schema drift.
 */
import registry from "./proposal-template-registry.json";

export type ProposalVoteMode = "fixed" | "trailing";
export type TemplateLocale = "en" | "ar";

export interface ProposalTemplate {
  id: string;
  version: number;
  name: string;
  description: string;
  titlePlaceholder: string;
  bodyScaffold: string;
  voteMode: ProposalVoteMode;
  deadlineSeconds: number;
}

type RegistryTemplate = (typeof registry.templates)[number];

function localizeTemplate(source: RegistryTemplate, locale: TemplateLocale): ProposalTemplate {
  return {
    id: source.id,
    version: source.version,
    name: source.name[locale],
    description: source.description[locale],
    titlePlaceholder: source.titlePlaceholder[locale],
    bodyScaffold: source.bodyScaffold[locale],
    voteMode: source.voteMode as ProposalVoteMode,
    deadlineSeconds: source.deadlineSeconds,
  };
}

export function getLocalizedProposalTemplates(locale: TemplateLocale = "en"): ProposalTemplate[] {
  return registry.templates.map((entry) => localizeTemplate(entry, locale));
}

export const PROPOSAL_TEMPLATES: ProposalTemplate[] = getLocalizedProposalTemplates("en");

export function getProposalTemplate(id: string, locale: TemplateLocale = "en"): ProposalTemplate | undefined {
  const source = registry.templates.find((entry) => entry.id === id);
  return source ? localizeTemplate(source, locale) : undefined;
}

/**
 * Mirror the backend's on-chain 100-UTF8-byte title bound and IPFS metadata
 * body/video URL constraints. Users can edit template defaults, but invalid
 * changes are rejected BEFORE uploading to IPFS.
 */
export function validateProposalTemplateDraft(draft: {
  title: string;
  body: string;
  videoUrl?: string;
  voteMode: string;
  deadlineSeconds: number;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  const title = draft.title.normalize("NFC");
  const bytes = new TextEncoder().encode(title).length;
  if (!title.trim() || bytes > 100 ||
      /[\u200B-\u200D\uFEFF\u0000-\u001F\u007F-\u009F]/.test(title)) {
    errors.title = "Title must be 1–100 UTF-8 bytes without hidden/control characters.";
  }
  if (draft.body.length > 100000) errors.body = "Description must be 100,000 characters or less.";
  if (draft.videoUrl && !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\/.+$/i.test(draft.videoUrl)) {
    errors.videoUrl = "Use a valid HTTPS or HTTP YouTube/Vimeo link.";
  }
  if (draft.voteMode !== "fixed" && draft.voteMode !== "trailing") {
    errors.voteMode = "Select a supported voting mode.";
  }
  if (!Number.isFinite(draft.deadlineSeconds) || draft.deadlineSeconds <= 0) {
    errors.deadlineSeconds = "Choose a positive deadline.";
  }
  return errors;
}
