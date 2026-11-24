/**
 * Unified Store Module with Global Clear & Sanitization Support
 */

import { userStore } from "./userStore";
import { electionStore } from "./electionStore";
import { uiStore } from "./uiStore";
import { submissionQueue } from "./submissionQueue";
import { configureDevtools } from "./secureStorage";

export * from "./secureStorage";
export * from "./userStore";
export * from "./electionStore";
export * from "./uiStore";
export * from "./submissionQueue";

// Initialize devtools protection
configureDevtools();

/**
 * Clears all store states and sensitive data (on logout/disconnect).
 *
 * Unsent vote proofs are kept: they hold no secrets (only the formatted
 * proof and public signals), are bound to the account that built them, and
 * resume when that account reconnects (#750).
 */
export function clearAllStores(): void {
  userStore.clearUser();
  electionStore.clearElectionStore();
  uiStore.clearUIStore();
  submissionQueue.clearSettled();
}
