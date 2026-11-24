/**
 * Stellar address helpers (#594).
 *
 * G... = ed25519 account, M... = muxed sub-account (base + 64-bit ID).
 * They are NOT interchangeable: paying an M... recipient via the bare G...
 * base credits the shared balance and the funds are lost to the recipient.
 */

export type StellarAddressKind = "G" | "M" | null;

const G_RE = /^G[A-Z2-7]{55}$/;
const M_RE = /^M[A-Z2-7]{68}$/;

export function classifyStellarAddress(value: string): StellarAddressKind {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (G_RE.test(v)) return "G";
  if (M_RE.test(v)) return "M";
  return null;
}

export function isValidStellarDestination(value: string): boolean {
  return classifyStellarAddress(value) !== null;
}

export function describeStellarAddress(value: string): string {
  const kind = classifyStellarAddress(value);
  if (kind === "M") return "Muxed sub-account (M...) — funds route to the virtual ID";
  if (kind === "G") return "Base account (G...)";
  return "Invalid Stellar address — must be G... (56 chars) or M... (69 chars)";
}

/**
 * Parse Stellar QR / URI payloads (SEP-7 `web+stellar:pay?...` or raw
 * address with optional `?memo=` query). Returns the bare destination plus
 * an optional memo. Rejects payloads whose destination is not G.../M....
 */
export function parseStellarQr(payload: string): { destination: string; memo?: string } {
  const raw = (payload || "").trim();
  if (!raw) throw new Error("Empty QR payload");
  // SEP-7 URI form
  const uriMatch = raw.match(/^web\+stellar:(pay|tx)\?([^#]*)/i);
  const query = uriMatch ? uriMatch[2] : raw.includes("?") ? raw.split("?")[1] : "";
  let candidate = uriMatch ? "" : raw.split("?")[0];
  let memo: string | undefined;
  if (query) {
    const params = new URLSearchParams(query);
    candidate = candidate || params.get("destination") || "";
    memo = params.get("memo") || undefined;
  }
  candidate = candidate.trim();
  if (classifyStellarAddress(candidate) === null) {
    throw new Error("QR destination must be a valid G... or M... address");
  }
  return memo ? { destination: candidate, memo } : { destination: candidate };
}
