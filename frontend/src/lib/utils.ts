import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Truncate a Stellar address for display
 * @param address Full Stellar address (e.g., GDXYZ...)
 * @param startChars Number of characters to show at start (default: 4)
 * @param endChars Number of characters to show at end (default: 4)
 */
export function truncateAddress(
  address: string,
  startChars = 4,
  endChars = 4,
): string {
  if (!address || address.length <= startChars + endChars + 3) {
    return address;
  }
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

/**
 * Truncate text to a maximum length
 * @param text Text to truncate
 * @param maxLength Maximum length before truncation (default: 30)
 */
export function truncateText(text: string, maxLength = 30): string {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

/**
 * Check if an error is a user rejection (user cancelled wallet action)
 */
export function isUserRejection(err: unknown): boolean {
  if (!err) return false;

  const error = err as { code?: number; message?: string };

  return (
    error.code === -4 ||
    error.message?.includes("User rejected") === true ||
    error.message?.includes("user rejected") === true ||
    error.message?.includes("declined") === true ||
    error.message?.includes("cancelled") === true ||
    error.message?.includes("canceled") === true
  );
}

/**
 * Handle transaction errors with user rejection detection
 * @param err The error that occurred
 * @param setError Function to set error message (only called for non-user-rejection errors)
 * @param errorMessage Custom error message (optional)
 * @returns true if error was handled (user rejection), false if error was set
 */
export function handleTransactionError(
  err: unknown,
  setError: (msg: string) => void,
  errorMessage?: string,
): boolean {
  if (isUserRejection(err)) {
    if (import.meta.env.DEV) console.log("User cancelled the transaction");
    return true;
  }

  const message =
    errorMessage || (err instanceof Error ? err.message : "Transaction failed");
  setError(message);
  return false;
}

/**
 * Check if an error is an "account not found" error (unfunded account)
 */
export function isAccountNotFoundError(err: unknown): boolean {
  if (!err) return false;

  const errorMessage = err instanceof Error ? err.message : String(err);
  return (
    errorMessage.includes("Account not found") ||
    errorMessage.includes("does not exist") ||
    errorMessage.includes("account not found")
  );
}

/**
 * Convert a string to a URL-safe slug
 * @param text Text to convert to slug
 */
export function toSlug(text: string | undefined | null): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove non-word chars (except spaces and hyphens)
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Replace multiple hyphens with single
    .replace(/^-|-$/g, ""); // Remove leading/trailing hyphens
}

/**
 * Create a URL path with ID and slug (e.g., "2-test-dao")
 * @param id Numeric ID
 * @param name Name to slugify
 */
export function toIdSlug(id: number, name: string): string {
  const slug = toSlug(name);
  return slug ? `${id}-${slug}` : `${id}`;
}

/**
 * Parse an ID from an ID-slug string (e.g., "2-test-dao" -> 2)
 * @param idSlug String containing ID and optional slug
 */
export function parseIdFromSlug(idSlug: string): number | null {
  const match = idSlug.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract transaction hash from a Stellar SDK transaction result
 * The result can be a sendResult or assembled transaction
 */
export function extractTxHash(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;

  const res = result as Record<string, unknown>;

  // Direct hash property
  if (typeof res.hash === "string") return res.hash;

  // From sendTransaction result
  if (
    res.sendTransactionResponse &&
    typeof res.sendTransactionResponse === "object"
  ) {
    const sendRes = res.sendTransactionResponse as Record<string, unknown>;
    if (typeof sendRes.hash === "string") return sendRes.hash;
  }

  // From getTransaction result
  if (
    res.getTransactionResponse &&
    typeof res.getTransactionResponse === "object"
  ) {
    const getRes = res.getTransactionResponse as Record<string, unknown>;
    if (typeof getRes.txHash === "string") return getRes.txHash;
  }

  return null;
}
