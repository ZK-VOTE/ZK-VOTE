/**
 * Combined Fault Injection Framework
 * Enables testing multiple simultaneous failures during election scenarios
 */

export enum FaultType {
  FEE_SURGE = 'fee_surge',
  PANIC_MODE = 'panic_mode',
  KEY_ROTATION = 'key_rotation',
  NETWORK_CONGESTION = 'network_congestion',
  BACKEND_DEGRADATION = 'backend_degradation',
  PUSH_FAILURE = 'push_failure',
  DISPUTE_SURGE = 'dispute_surge',
  /** Protocol upgrade train applied while votes are in flight (ZV upgrade drill). */
  CONTRACT_UPGRADE = 'contract_upgrade',
  MIGRATION_WINDOW = 'migration_window'
}

export interface FaultConfig {
  type: FaultType
  severity: number // 1-10
  duration: number // milliseconds
  params?: Record<string, any>
}

export interface CombinedFaultScenario {
  name: string
  description: string
  faults: FaultConfig[]
  expectedSLOs: {
    minSuccessRate: number
    maxLatencyP99: number
    minAvailability: number
  }
}

export class ChaosHarness {
  private activeFaults: Set<FaultType> = new Set()
  private faultInjectors: Map<FaultType, FaultInjector> = new Map()

  constructor() {
    this.registerInjectors()
  }

  private registerInjectors() {
    this.faultInjectors.set(FaultType.FEE_SURGE, new FeeSurgeInjector())
    this.faultInjectors.set(FaultType.PANIC_MODE, new PanicModeInjector())
    this.faultInjectors.set(FaultType.KEY_ROTATION, new KeyRotationInjector())
    this.faultInjectors.set(FaultType.NETWORK_CONGESTION, new NetworkCongestionInjector())
    this.faultInjectors.set(FaultType.BACKEND_DEGRADATION, new BackendDegradationInjector())
    this.faultInjectors.set(FaultType.PUSH_FAILURE, new PushFailureInjector())
    this.faultInjectors.set(FaultType.DISPUTE_SURGE, new DisputeSurgeInjector())
  }

  async injectFault(config: FaultConfig): Promise<void> {
    const injector = this.faultInjectors.get(config.type)
    if (!injector) {
      throw new Error(`No injector found for fault type: ${config.type}`)
    }

    this.activeFaults.add(config.type)
    await injector.inject(config)

    if (config.duration > 0) {
      setTimeout(() => this.clearFault(config.type), config.duration)
    }
  }

  async clearFault(type: FaultType): Promise<void> {
    const injector = this.faultInjectors.get(type)
    if (injector) {
      await injector.clear()
      this.activeFaults.delete(type)
    }
  }

  async runScenario(scenario: CombinedFaultScenario): Promise<ScenarioResult> {
    console.log(`Starting scenario: ${scenario.name}`)
    const startTime = Date.now()
    const metrics: ScenarioMetrics = {
      totalAttempts: 0,
      successfulVotes: 0,
      failedVotes: 0,
      latencies: [],
      errors: []
    }

    // Inject all faults
    await Promise.all(scenario.faults.map(f => this.injectFault(f)))

    // Monitor for duration
    const maxDuration = Math.max(...scenario.faults.map(f => f.duration))
    await this.monitorMetrics(metrics, maxDuration)

    // Clear all faults
    await this.clearAllFaults()

    const endTime = Date.now()
    return this.evaluateResults(scenario, metrics, endTime - startTime)
  }

  private async monitorMetrics(metrics: ScenarioMetrics, duration: number): Promise<void> {
    // Implementation would hook into actual system metrics
    // Placeholder for monitoring logic
    await new Promise(resolve => setTimeout(resolve, duration))
  }

  private async clearAllFaults(): Promise<void> {
    await Promise.all(
      Array.from(this.activeFaults).map(type => this.clearFault(type))
    )
  }

  private evaluateResults(
    scenario: CombinedFaultScenario,
    metrics: ScenarioMetrics,
    duration: number
  ): ScenarioResult {
    const successRate = metrics.successfulVotes / metrics.totalAttempts
    const p99Latency = this.calculateP99(metrics.latencies)
    const availability = 1 - (metrics.failedVotes / metrics.totalAttempts)

    const slosMetResult = {
      successRate: successRate >= scenario.expectedSLOs.minSuccessRate,
      latency: p99Latency <= scenario.expectedSLOs.maxLatencyP99,
      availability: availability >= scenario.expectedSLOs.minAvailability
    }

    return {
      scenario: scenario.name,
      duration,
      metrics,
      slosMetResult,
      passed: Object.values(slosMetResult).every(v => v)
    }
  }

  private calculateP99(latencies: number[]): number {
    if (latencies.length === 0) return 0
    const sorted = [...latencies].sort((a, b) => a - b)
    const index = Math.floor(sorted.length * 0.99)
    return sorted[index]
  }
}

// Fault injector base class
abstract class FaultInjector {
  abstract inject(config: FaultConfig): Promise<void>
  abstract clear(): Promise<void>
}

class FeeSurgeInjector extends FaultInjector {
  async inject(config: FaultConfig): Promise<void> {
    const multiplier = config.params?.multiplier || 10
    console.log(`Injecting fee surge: ${multiplier}x normal`)
    // Implementation would interact with Stellar test network
  }

  async clear(): Promise<void> {
    console.log('Clearing fee surge')
  }
}

class PanicModeInjector extends FaultInjector {
  async inject(config: FaultConfig): Promise<void> {
    console.log('Activating panic mode')
    // Implementation would trigger panic via API
  }

  async clear(): Promise<void> {
    console.log('Deactivating panic mode')
  }
}

class KeyRotationInjector extends FaultInjector {
  async inject(config: FaultConfig): Promise<void> {
    console.log('Starting key rotation under load')
    // Implementation would trigger rotation procedure
  }

  async clear(): Promise<void> {
    console.log('Rotation complete')
  }
}

class NetworkCongestionInjector extends FaultInjector {
  async inject(config: FaultConfig): Promise<void> {
    const latency = config.params?.latency || 2000
    console.log(`Injecting network congestion: ${latency}ms latency`)
    // Implementation would add artificial delays
  }

  async clear(): Promise<void> {
    console.log('Clearing network congestion')
  }
}

class BackendDegradationInjector extends FaultInjector {
  async inject(config: FaultConfig): Promise<void> {
    const errorRate = config.params?.errorRate || 0.2
    console.log(`Injecting backend degradation: ${errorRate * 100}% error rate`)
  }

  async clear(): Promise<void> {
    console.log('Clearing backend degradation')
  }
}

class PushFailureInjector extends FaultInjector {
  async inject(config: FaultConfig): Promise<void> {
    console.log('Disabling push notifications')
  }

  async clear(): Promise<void> {
    console.log('Re-enabling push notifications')
  }
}

class DisputeSurgeInjector extends FaultInjector {
  async inject(config: FaultConfig): Promise<void> {
    const volume = config.params?.volume || 100
    console.log(`Injecting dispute surge: ${volume} disputes`)
  }

  async clear(): Promise<void> {
    console.log('Clearing dispute surge')
  }
}

export interface ScenarioMetrics {
  totalAttempts: number
  successfulVotes: number
  failedVotes: number
  latencies: number[]
  errors: string[]
}

export interface ScenarioResult {
  scenario: string
  duration: number
  metrics: ScenarioMetrics
  slosMetResult: {
    successRate: boolean
    latency: boolean
    availability: boolean
  }
  passed: boolean
}
