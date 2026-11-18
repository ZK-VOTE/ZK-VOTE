/**
 * Privacy-bounded SIEM delivery for abuse detections.
 *
 * Configure ABUSE_SIEM_WEBHOOK_URL with an HTTPS endpoint. The webhook
 * receives pattern names and aggregate metadata only; payment destinations,
 * raw payment records, and request context are deliberately excluded.
 */

import { log } from "./logger.js";
import type { AbuseDetectionResult } from "./abuseDetection.js";

const DELIVERY_TIMEOUT_MS = 5_000;

export interface AbuseSiemEvent {
  event: "zkvote.abuse.detected";
  occurredAt: string;
  severity: "high" | "critical";
  patterns: string[];
  confidence: number;
  aggregate: Record<string, unknown>;
}

function getWebhookUrl(): URL | null {
  const configured = process.env.ABUSE_SIEM_WEBHOOK_URL?.trim();
  if (!configured) return null;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("ABUSE_SIEM_WEBHOOK_URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("ABUSE_SIEM_WEBHOOK_URL must use HTTPS");
  }
  return url;
}

/**
 * Sends one normalized detection event. Delivery failures are surfaced to
 * the caller so the audit record remains the durable source of truth.
 */
export async function dispatchAbuseDetectionToSiem(
  result: AbuseDetectionResult,
): Promise<boolean> {
  const url = getWebhookUrl();
  if (!url) return false;

  const event: AbuseSiemEvent = {
    event: "zkvote.abuse.detected",
    occurredAt: new Date(result.timestamp).toISOString(),
    severity: result.confidence >= 0.9 ? "critical" : "high",
    patterns: [...new Set(result.patterns)],
    confidence: Math.max(0, Math.min(1, result.confidence)),
    aggregate: result.metadata,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "ZK-VOTE-Abuse-Monitor/1.0",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`SIEM webhook returned HTTP ${response.status}`);
  }

  log("info", "abuse_detection_sent_to_siem", {
    status: response.status,
    patterns: event.patterns,
  });
  return true;
}
