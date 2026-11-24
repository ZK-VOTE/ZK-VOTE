import { describe, expect, it } from "vitest";
import {
  PROPOSAL_TEMPLATES,
  getLocalizedProposalTemplates,
  validateProposalTemplateDraft,
} from "./proposalTemplates";

describe("ZV-128 template schema registry", () => {
  it("has versioned templates safe under the same draft validation as backend", () => {
    for (const template of PROPOSAL_TEMPLATES) {
      expect(template.version).toBeGreaterThan(0);
      expect(validateProposalTemplateDraft({
        title: template.titlePlaceholder, body: template.bodyScaffold,
        voteMode: template.voteMode, deadlineSeconds: template.deadlineSeconds,
      })).toEqual({});
    }
  });

  it("provides RTL language strings without unsafe bidi controls", () => {
    const localized = getLocalizedProposalTemplates("ar");
    expect(localized).toHaveLength(PROPOSAL_TEMPLATES.length);
    expect(localized[0].name).not.toBe(PROPOSAL_TEMPLATES[0].name);
    for (const template of localized) {
      expect(template.titlePlaceholder).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
      expect(validateProposalTemplateDraft({
        title: template.titlePlaceholder, body: template.bodyScaffold,
        voteMode: template.voteMode, deadlineSeconds: template.deadlineSeconds,
      })).toEqual({});
    }
  });

  it("blocks malicious URLs and overlong UTF-8 titles before upload", () => {
    const bad = validateProposalTemplateDraft({
      title: "é".repeat(70), body: "ok", videoUrl: "javascript:alert(1)",
      voteMode: "fixed", deadlineSeconds: 86400,
    });
    expect(bad.title).toBeDefined();
    expect(bad.videoUrl).toBeDefined();
  });
});
