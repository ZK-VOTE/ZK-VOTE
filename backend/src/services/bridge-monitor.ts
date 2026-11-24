/**
 * Cross-chain Bridge Monitor
 * Tracks mirroring lag and cross-chain state consistency
 */

import { createLogger } from './logger.js'

const logger = createLogger('bridge-monitor')

export interface ChainState {
  chain: 'soroban' | 'evm'
  blockHeight: number
  lastUpdate: Date
  merkleRoot: string
  proposalCount: number
}

export interface MirrorLag {
  membershipRootLag: number // milliseconds
  proposalStateLag: number
  lastMirrorTime: Date
  status: 'healthy' | 'degraded' | 'critical'
}

export class BridgeMonitor {
  private sorobanState?: ChainState
  private evmState?: ChainState
  private lagThresholds = {
    warning: 30 * 60 * 1000, // 30 minutes
    critical: 60 * 60 * 1000  // 60 minutes
  }

  /**
   * Update Soroban chain state
   */
  updateSorobanState(state: Partial<ChainState>): void {
    this.sorobanState = {
      chain: 'soroban',
      blockHeight: state.blockHeight || 0,
      lastUpdate: new Date(),
      merkleRoot: state.merkleRoot || '',
      proposalCount: state.proposalCount || 0
    }
  }

  /**
   * Update EVM chain state
   */
  updateEvmState(state: Partial<ChainState>): void {
    this.evmState = {
      chain: 'evm',
      blockHeight: state.blockHeight || 0,
      lastUpdate: new Date(),
      merkleRoot: state.merkleRoot || '',
      proposalCount: state.proposalCount || 0
    }
  }

  /**
   * Calculate current mirror lag
   */
  getMirrorLag(): MirrorLag {
    if (!this.sorobanState || !this.evmState) {
      return {
        membershipRootLag: 0,
        proposalStateLag: 0,
        lastMirrorTime: new Date(),
        status: 'critical'
      }
    }

    const timeDiff = Math.abs(
      this.sorobanState.lastUpdate.getTime() - this.evmState.lastUpdate.getTime()
    )

    let status: 'healthy' | 'degraded' | 'critical'
    if (timeDiff < this.lagThresholds.warning) {
      status = 'healthy'
    } else if (timeDiff < this.lagThresholds.critical) {
      status = 'degraded'
    } else {
      status = 'critical'
    }

    return {
      membershipRootLag: timeDiff,
      proposalStateLag: Math.abs(this.sorobanState.proposalCount - this.evmState.proposalCount),
      lastMirrorTime: this.evmState.lastUpdate,
      status
    }
  }

  /**
   * Check for state divergence
   */
  checkDivergence(): {
    diverged: boolean
    differences: string[]
  } {
    if (!this.sorobanState || !this.evmState) {
      return {
        diverged: true,
        differences: ['Chain states not initialized']
      }
    }

    const differences: string[] = []

    // Check merkle root
    if (this.sorobanState.merkleRoot !== this.evmState.merkleRoot) {
      differences.push(`Merkle root mismatch: Soroban=${this.sorobanState.merkleRoot} EVM=${this.evmState.merkleRoot}`)
    }

    // Check proposal count
    const proposalDiff = Math.abs(this.sorobanState.proposalCount - this.evmState.proposalCount)
    if (proposalDiff > 1) {
      differences.push(`Proposal count diverged by ${proposalDiff}`)
    }

    return {
      diverged: differences.length > 0,
      differences
    }
  }

  /**
   * Get monitoring status for metrics
   */
  getStatus() {
    const lag = this.getMirrorLag()
    const divergence = this.checkDivergence()

    return {
      soroban: this.sorobanState,
      evm: this.evmState,
      lag,
      divergence,
      healthy: lag.status === 'healthy' && !divergence.diverged
    }
  }

  /**
   * Trigger mirror operation
   */
  async triggerMirror(type: 'membership' | 'proposal'): Promise<void> {
    logger.info('bridge_mirror_started', { type })
    
    if (!this.sorobanState) {
      throw new Error('Soroban state not available')
    }

    // In production, would submit cross-chain message via bridge
    await this.sleep(2000)
    
    logger.info('bridge_mirror_complete', { type })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export const bridgeMonitor = new BridgeMonitor()
