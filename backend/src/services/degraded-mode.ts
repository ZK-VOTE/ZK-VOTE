/**
 * Degraded Mode Service
 * Manages graceful degradation during combined fault scenarios
 *
 * Changes (#922):
 * - Reasons are now persisted as a serialisable map (reason → level) so the
 *   full set survives serialisation across replicas (write to shared store if
 *   needed; the type is intentionally a plain record for JSON round-trips).
 * - Per-endpoint DataStatus matrix exposed via `endpointStatus()`.
 * - Cursor-based replay/dedup: `shouldReplay()` / `markReplayed()` track
 *   which event cursors have already been processed after a reconnect so the
 *   same event is never handled twice.
 */

export enum DegradationLevel {
  NORMAL = 0,
  SLIGHT = 1,
  MODERATE = 2,
  SEVERE = 3,
  CRITICAL = 4
}

/** Data freshness status reported per endpoint in responses. */
export type DataStatus = "fresh" | "cached" | "degraded" | "unavailable"

export interface DegradationState {
  level: DegradationLevel
  activeReasons: string[]
  startedAt: Date
  expectedRecovery?: Date
}

/**
 * Per-endpoint status matrix: each endpoint declares what data status it
 * provides at each degradation level.  Absent entries fall back to the
 * generic mapping in `endpointStatus()`.
 */
const ENDPOINT_STATUS_MATRIX: Record<string, Partial<Record<DegradationLevel, DataStatus>>> = {
  "daos/list": {
    [DegradationLevel.NORMAL]: "fresh",
    [DegradationLevel.SLIGHT]: "cached",
    [DegradationLevel.MODERATE]: "cached",
    [DegradationLevel.SEVERE]: "degraded",
    [DegradationLevel.CRITICAL]: "unavailable",
  },
  "daos/get": {
    [DegradationLevel.NORMAL]: "fresh",
    [DegradationLevel.SLIGHT]: "cached",
    [DegradationLevel.MODERATE]: "cached",
    [DegradationLevel.SEVERE]: "degraded",
    [DegradationLevel.CRITICAL]: "unavailable",
  },
  "proposals/list": {
    [DegradationLevel.NORMAL]: "fresh",
    [DegradationLevel.SLIGHT]: "cached",
    [DegradationLevel.MODERATE]: "degraded",
    [DegradationLevel.SEVERE]: "unavailable",
    [DegradationLevel.CRITICAL]: "unavailable",
  },
  "vote/submit": {
    [DegradationLevel.NORMAL]: "fresh",
    [DegradationLevel.SLIGHT]: "fresh",
    [DegradationLevel.MODERATE]: "fresh",
    [DegradationLevel.SEVERE]: "fresh",
    [DegradationLevel.CRITICAL]: "fresh",
  },
  "payment/submit": {
    [DegradationLevel.NORMAL]: "fresh",
    [DegradationLevel.SLIGHT]: "fresh",
    [DegradationLevel.MODERATE]: "fresh",
    [DegradationLevel.SEVERE]: "fresh",
    [DegradationLevel.CRITICAL]: "fresh",
  },
}

export class DegradedModeService {
  private currentLevel: DegradationLevel = DegradationLevel.NORMAL
  /**
   * Serialisable reason → level map.  Stored as a plain record so it can be
   * round-tripped through JSON for cross-replica propagation.
   */
  private reasonLevels: Record<string, DegradationLevel> = {}
  /** Dedup set for cursor-based replay after reconnect. */
  private replayedCursors: Set<string> = new Set()
  private degradationStartTime?: Date

  /**
   * Trigger degradation for a specific reason
   */
  triggerDegradation(reason: string, level: DegradationLevel): void {
    this.reasonLevels[reason] = level

    if (level > this.currentLevel) {
      this.currentLevel = level
      if (!this.degradationStartTime) {
        this.degradationStartTime = new Date()
      }
      console.warn(`Degradation level increased to ${DegradationLevel[level]} due to: ${reason}`)
    }
  }

  /**
   * Clear degradation for a specific reason
   */
  clearDegradation(reason: string): void {
    delete this.reasonLevels[reason]

    if (Object.keys(this.reasonLevels).length === 0) {
      this.currentLevel = DegradationLevel.NORMAL
      this.degradationStartTime = undefined
      console.info('System recovered to normal operation')
    } else {
      this.recalculateLevel()
    }
  }

  /**
   * Get current degradation state
   */
  getState(): DegradationState {
    return {
      level: this.currentLevel,
      activeReasons: Object.keys(this.reasonLevels),
      startedAt: this.degradationStartTime || new Date(),
      expectedRecovery: this.estimateRecovery()
    }
  }

  /**
   * Return the data status for a named endpoint at the current degradation level.
   * Endpoints not in the matrix use a generic mapping.
   */
  endpointStatus(endpoint: string): DataStatus {
    const matrix = ENDPOINT_STATUS_MATRIX[endpoint]
    if (matrix) {
      const status = matrix[this.currentLevel]
      if (status !== undefined) return status
    }
    // Generic fallback
    switch (this.currentLevel) {
      case DegradationLevel.NORMAL: return "fresh"
      case DegradationLevel.SLIGHT: return "cached"
      case DegradationLevel.MODERATE: return "cached"
      case DegradationLevel.SEVERE: return "degraded"
      case DegradationLevel.CRITICAL: return "unavailable"
      default: return "fresh"
    }
  }

  /**
   * Merge serialised reason map from another replica.
   * Existing reasons with a higher level are kept.
   */
  mergeReasonLevels(remote: Record<string, DegradationLevel>): void {
    for (const [reason, level] of Object.entries(remote)) {
      if ((this.reasonLevels[reason] ?? -1) < level) {
        this.triggerDegradation(reason, level)
      }
    }
  }

  /**
   * Serialise the current reason map for cross-replica propagation.
   */
  exportReasonLevels(): Record<string, DegradationLevel> {
    return { ...this.reasonLevels }
  }

  // ── Replay / dedup ──────────────────────────────────────────────────────

  /**
   * Returns true if `cursor` has NOT yet been replayed and marks it as seen.
   * Call this for every event cursor during reconnect replay; events that
   * return false have already been processed and must be skipped.
   */
  shouldReplay(cursor: string): boolean {
    if (this.replayedCursors.has(cursor)) return false
    this.replayedCursors.add(cursor)
    return true
  }

  /**
   * Explicitly mark a cursor as replayed (for callers that handle the event
   * outside `shouldReplay`).
   */
  markReplayed(cursor: string): void {
    this.replayedCursors.add(cursor)
  }

  /** Clear the replay dedup set (call after a full reconnect cycle completes). */
  clearReplayState(): void {
    this.replayedCursors.clear()
  }

  /**
   * Check if a feature should be available at current degradation level
   */
  isFeatureAvailable(feature: string): boolean {
    const requirements = FEATURE_REQUIREMENTS[feature] || DegradationLevel.NORMAL
    return this.currentLevel <= requirements
  }

  /**
   * Get rate limit multiplier based on degradation level
   */
  getRateLimitMultiplier(): number {
    switch (this.currentLevel) {
      case DegradationLevel.NORMAL:
        return 1.0
      case DegradationLevel.SLIGHT:
        return 0.8
      case DegradationLevel.MODERATE:
        return 0.5
      case DegradationLevel.SEVERE:
        return 0.3
      case DegradationLevel.CRITICAL:
        return 0.1
      default:
        return 1.0
    }
  }

  /**
   * Get timeout multiplier for operations
   */
  getTimeoutMultiplier(): number {
    switch (this.currentLevel) {
      case DegradationLevel.NORMAL:
        return 1.0
      case DegradationLevel.SLIGHT:
        return 1.5
      case DegradationLevel.MODERATE:
        return 2.0
      case DegradationLevel.SEVERE:
        return 3.0
      case DegradationLevel.CRITICAL:
        return 5.0
      default:
        return 1.0
    }
  }

  /**
   * Get retry strategy for current level
   */
  getRetryStrategy(): { maxRetries: number; backoffMs: number } {
    switch (this.currentLevel) {
      case DegradationLevel.NORMAL:
        return { maxRetries: 3, backoffMs: 1000 }
      case DegradationLevel.SLIGHT:
        return { maxRetries: 5, backoffMs: 2000 }
      case DegradationLevel.MODERATE:
        return { maxRetries: 7, backoffMs: 3000 }
      case DegradationLevel.SEVERE:
        return { maxRetries: 10, backoffMs: 5000 }
      case DegradationLevel.CRITICAL:
        return { maxRetries: 15, backoffMs: 10000 }
      default:
        return { maxRetries: 3, backoffMs: 1000 }
    }
  }

  /**
   * Should queue operation instead of executing immediately?
   */
  shouldQueue(operationType: string): boolean {
    if (this.currentLevel <= DegradationLevel.SLIGHT) {
      return false
    }

    const criticalOps = ['vote_submission', 'tally_verification']
    return !criticalOps.includes(operationType)
  }

  private recalculateLevel(): void {
    const levels = Object.values(this.reasonLevels)
    if (levels.length === 0) {
      this.currentLevel = DegradationLevel.NORMAL
      return
    }
    this.currentLevel = Math.max(...levels) as DegradationLevel
  }

  private estimateRecovery(): Date | undefined {
    if (!this.degradationStartTime) {
      return undefined
    }

    // Simple estimation - would be more sophisticated in production
    const hoursToRecover = this.currentLevel * 0.5
    const recovery = new Date(this.degradationStartTime)
    recovery.setHours(recovery.getHours() + hoursToRecover)
    return recovery
  }
}

// Feature availability requirements
const FEATURE_REQUIREMENTS: Record<string, DegradationLevel> = {
  'vote_submission': DegradationLevel.CRITICAL,
  'tally_verification': DegradationLevel.CRITICAL,
  'membership_registration': DegradationLevel.SEVERE,
  'dao_creation': DegradationLevel.MODERATE,
  'comment_submission': DegradationLevel.SLIGHT,
  'search': DegradationLevel.SLIGHT,
  'analytics': DegradationLevel.NORMAL
}

// Singleton instance
export const degradedMode = new DegradedModeService()
