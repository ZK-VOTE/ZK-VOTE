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
 * Clears all store states and sensitive data (on logout/disconnect)
 */
export function clearAllStores(): void {
  userStore.clearUser();
  electionStore.clearElectionStore();
  uiStore.clearUIStore();
  submissionQueue.clearAll();
}
