/**
 * Tests for the SubmissionQueueBanner component.
 *
 * Covers:
 * - Renders nothing when nothing to show
 * - Offline status banner
 * - Pending submissions banner
 * - Conflict card renders with dismiss
 * - Failure card renders with dismiss
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SubmissionQueueBanner } from "./SubmissionQueueBanner";
import { submissionQueue } from "../store/submissionQueue";
import type { VotePayload } from "../store/submissionQueue";

// ──────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────

vi.mock("../lib/queueProcessor", () => ({
  startProcessor: vi.fn(),
  stopProcessor: vi.fn(),
  processQueue: vi.fn().mockResolvedValue(undefined),
}));

const localStorageStore: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (k: string) => localStorageStore[k] ?? null,
    setItem: (k: string, v: string) => { localStorageStore[k] = v; },
    removeItem: (k: string) => { delete localStorageStore[k]; },
    clear: () =>
      Object.keys(localStorageStore).forEach(
        (k) => delete localStorageStore[k],
      ),
    length: 0,
    key: () => null,
  },
  writable: true,
});

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function makePayload(nullifier: string): VotePayload {
  return {
    daoId: 1,
    proposalId: 7,
    choice: true,
    nullifier,
    root: "root",
    proof: { a: "a", b: "b", c: "c" },
    timestamp: Date.now(),
  };
}

// ──────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────

beforeEach(() => {
  Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
  submissionQueue.clearAll();
  vi.clearAllMocks();
  // Restore online state
  Object.defineProperty(navigator, "onLine", {
    get: () => true,
    configurable: true,
  });
});

afterEach(() => {
  submissionQueue.clearAll();
});

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe("SubmissionQueueBanner", () => {
  it("renders nothing when there is nothing to show", () => {
    const { container } = render(<SubmissionQueueBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("shows pending banner when there are pending entries", () => {
    submissionQueue.enqueue(makePayload("pending_banner"));

    render(<SubmissionQueueBanner />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/queued vote/i)).toBeInTheDocument();
  });

  it("shows offline banner when browser is offline", () => {
    Object.defineProperty(navigator, "onLine", {
      get: () => false,
      configurable: true,
    });

    render(<SubmissionQueueBanner />);

    // Trigger offline state
    fireEvent(window, new Event("offline"));

    expect(screen.queryByText(/offline/i)).not.toBeNull();
  });

  it("renders conflict card with correct text", () => {
    submissionQueue.enqueue(makePayload("conflict_banner"));
    submissionQueue.markSubmitting("conflict_banner");
    submissionQueue.markConflict(
      "conflict_banner",
      "You have already voted on this proposal.",
    );

    render(<SubmissionQueueBanner />);

    expect(screen.getByText("Vote Already Recorded")).toBeInTheDocument();
    expect(
      screen.getByText("You have already voted on this proposal."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Proposal #7/)).toBeInTheDocument();
  });

  it("conflict card shows dismiss button", () => {
    submissionQueue.enqueue(makePayload("conflict_dismiss"));
    submissionQueue.markSubmitting("conflict_dismiss");
    submissionQueue.markConflict("conflict_dismiss", "already voted");

    render(<SubmissionQueueBanner />);

    const dismissBtn = screen.getByRole("button", {
      name: /dismiss conflict/i,
    });
    expect(dismissBtn).toBeInTheDocument();
  });

  it("dismissing conflict card removes it from the UI", () => {
    submissionQueue.enqueue(makePayload("dismiss_ui"));
    submissionQueue.markSubmitting("dismiss_ui");
    submissionQueue.markConflict("dismiss_ui", "conflict detail");

    render(<SubmissionQueueBanner />);

    const dismissBtn = screen.getByRole("button", {
      name: /dismiss conflict/i,
    });
    fireEvent.click(dismissBtn);

    expect(screen.queryByText("Vote Already Recorded")).not.toBeInTheDocument();
  });

  it("renders failure card with correct text", () => {
    submissionQueue.enqueue(makePayload("fail_banner"));
    submissionQueue.markSubmitting("fail_banner");
    submissionQueue.markFailed("fail_banner", "Invalid proof submitted.");

    render(<SubmissionQueueBanner />);

    expect(screen.getByText("Vote Submission Failed")).toBeInTheDocument();
    expect(screen.getByText("Invalid proof submitted.")).toBeInTheDocument();
  });

  it("failure card shows dismiss button", () => {
    submissionQueue.enqueue(makePayload("fail_dismiss"));
    submissionQueue.markSubmitting("fail_dismiss");
    submissionQueue.markFailed("fail_dismiss", "error message");

    render(<SubmissionQueueBanner />);

    const dismissBtn = screen.getByRole("button", {
      name: /dismiss failure/i,
    });
    expect(dismissBtn).toBeInTheDocument();
  });

  it("dismissing failure card removes it from the UI", () => {
    submissionQueue.enqueue(makePayload("fail_remove"));
    submissionQueue.markSubmitting("fail_remove");
    submissionQueue.markFailed("fail_remove", "some error");

    render(<SubmissionQueueBanner />);

    const dismissBtn = screen.getByRole("button", {
      name: /dismiss failure/i,
    });
    fireEvent.click(dismissBtn);

    expect(screen.queryByText("Vote Submission Failed")).not.toBeInTheDocument();
  });

  it("has accessible role and aria-label on the region", () => {
    submissionQueue.enqueue(makePayload("aria_test"));

    render(<SubmissionQueueBanner />);

    const region = screen.getByRole("region", {
      name: /vote submission status/i,
    });
    expect(region).toBeInTheDocument();
  });

  it("conflict card has role=alert for screen readers", () => {
    submissionQueue.enqueue(makePayload("alert_role"));
    submissionQueue.markSubmitting("alert_role");
    submissionQueue.markConflict("alert_role", "already voted");

    render(<SubmissionQueueBanner />);

    const alerts = screen.getAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
  });
});
