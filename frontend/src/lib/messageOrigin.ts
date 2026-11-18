import originPolicy from "../config/message-origin-policy.json";

export type MessageScope = "swap" | "payment" | "ramp";

const ORIGINS_BY_FLOW: Record<MessageScope, ReadonlySet<string>> = {
  swap: new Set(originPolicy.flows.swap),
  payment: new Set(originPolicy.flows.payment),
  ramp: new Set(originPolicy.flows.ramp),
};

/**
 * Validate a postMessage origin against the reviewed per-flow policy.
 * Same-origin messages remain available for internal application messaging.
 */
export function isAllowedMessageOrigin(
  origin: string,
  scope: MessageScope = "swap",
): boolean {
  if (!origin || typeof origin !== "string") return false;

  if (typeof window !== "undefined" && origin === window.location.origin) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.protocol !== "https:") return false;
    return ORIGINS_BY_FLOW[scope].has(parsed.origin);
  } catch {
    return false;
  }
}
