/**
 * Remediation Routes - Accountable incident response
 *
 * Structured remediation actions with:
 * - Append-only audit (immutable)
 * - Authz via authGuard (requires RELAYER_AUTH_TOKEN)
 * - Replay-safe via idempotencyKey
 * - Tests for immutability, authz, replay safety
 *
 * Actions are intentionally generic but structured to support incident response:
 *   freeze_dao, unfreeze_dao, pause_voting, resume_voting,
 *   revoke_member, restore_member, emergency_pause, emergency_resume,
 *   rotate_vk, quarantine_proposal
 */
declare const router: import("express-serve-static-core").Router;
export type RemediationActionType = "freeze_dao" | "unfreeze_dao" | "pause_voting" | "resume_voting" | "revoke_member" | "restore_member" | "emergency_pause" | "emergency_resume" | "rotate_vk" | "quarantine_proposal";
export interface RemediationRecord {
    id: string;
    timestamp: string;
    action: RemediationActionType;
    target: string;
    reason: string;
    actor: string;
    actorIpHash: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
    txHash?: string | null;
    immutable: true;
}
export declare function getRemediationLog(): RemediationRecord[];
export declare function clearRemediationLog(): void;
export declare function getRemediationById(id: string): RemediationRecord | undefined;
export default router;
//# sourceMappingURL=remediation.d.ts.map