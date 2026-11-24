/**
 * Pre-defined election day combined fault scenarios
 */

import { CombinedFaultScenario, FaultType } from '../combined-faults'

export const SCENARIOS: CombinedFaultScenario[] = [
  {
    name: 'Fee Surge + Panic Mode',
    description: 'Most likely during election final hour - fee spike triggers panic',
    faults: [
      {
        type: FaultType.FEE_SURGE,
        severity: 8,
        duration: 300000, // 5 minutes
        params: { multiplier: 10 }
      },
      {
        type: FaultType.PANIC_MODE,
        severity: 9,
        duration: 900000, // 15 minutes
        params: { trigger: 'manual' }
      }
    ],
    expectedSLOs: {
      minSuccessRate: 0.90,
      maxLatencyP99: 30000,
      minAvailability: 0.95
    }
  },

  {
    name: 'Key Compromise + Rotation Under Load',
    description: 'Security incident during peak traffic requires hot rotation',
    faults: [
      {
        type: FaultType.KEY_ROTATION,
        severity: 7,
        duration: 600000, // 10 minutes
        params: { method: 'hot_swap' }
      },
      {
        type: FaultType.NETWORK_CONGESTION,
        severity: 6,
        duration: 600000,
        params: { latency: 2000 }
      }
    ],
    expectedSLOs: {
      minSuccessRate: 0.92,
      maxLatencyP99: 25000,
      minAvailability: 0.96
    }
  },

  {
    name: 'Network Congestion + Vote Submission Spike',
    description: 'Organic load scenario - final hour rush meets network issues',
    faults: [
      {
        type: FaultType.NETWORK_CONGESTION,
        severity: 7,
        duration: 900000, // 15 minutes
        params: { latency: 3000, jitter: 1000 }
      },
      {
        type: FaultType.FEE_SURGE,
        severity: 5,
        duration: 900000,
        params: { multiplier: 5 }
      }
    ],
    expectedSLOs: {
      minSuccessRate: 0.93,
      maxLatencyP99: 35000,
      minAvailability: 0.97
    }
  },

  {
    name: 'Panic Mode + Dispute Surge',
    description: 'User confusion amplification - panic causes support flood',
    faults: [
      {
        type: FaultType.PANIC_MODE,
        severity: 9,
        duration: 1800000, // 30 minutes
        params: { trigger: 'automated' }
      },
      {
        type: FaultType.DISPUTE_SURGE,
        severity: 6,
        duration: 1800000,
        params: { volume: 200 }
      }
    ],
    expectedSLOs: {
      minSuccessRate: 0.90,
      maxLatencyP99: 30000,
      minAvailability: 0.95
    }
  },

  {
    name: 'Backend Degradation + Push Notification Failure',
    description: 'Silent failure cascade - users unaware of issues',
    faults: [
      {
        type: FaultType.BACKEND_DEGRADATION,
        severity: 5,
        duration: 600000, // 10 minutes
        params: { errorRate: 0.15 }
      },
      {
        type: FaultType.PUSH_FAILURE,
        severity: 4,
        duration: 600000,
        params: { failureRate: 1.0 }
      }
    ],
    expectedSLOs: {
      minSuccessRate: 0.85,
      maxLatencyP99: 20000,
      minAvailability: 0.90
    }
  },

  {
    name: 'Rotation + Fee Escalation',
    description: 'Operational costs spike - rotation transactions become expensive',
    faults: [
      {
        type: FaultType.KEY_ROTATION,
        severity: 6,
        duration: 600000, // 10 minutes
        params: { method: 'standard' }
      },
      {
        type: FaultType.FEE_SURGE,
        severity: 8,
        duration: 600000,
        params: { multiplier: 15 }
      }
    ],
    expectedSLOs: {
      minSuccessRate: 0.88,
      maxLatencyP99: 40000,
      minAvailability: 0.94
    }
  },

  {
    name: 'Three-Way: Surge + Panic + Rotation',
    description: 'Worst-case scenario - everything fails simultaneously',
    faults: [
      {
        type: FaultType.FEE_SURGE,
        severity: 9,
        duration: 1200000, // 20 minutes
        params: { multiplier: 20 }
      },
      {
        type: FaultType.PANIC_MODE,
        severity: 10,
        duration: 1200000,
        params: { trigger: 'emergency' }
      },
      {
        type: FaultType.KEY_ROTATION,
        severity: 8,
        duration: 900000, // 15 minutes
        params: { method: 'emergency_rotation' }
      },
      {
        type: FaultType.NETWORK_CONGESTION,
        severity: 7,
        duration: 1200000,
        params: { latency: 5000 }
      }
    ],
    expectedSLOs: {
      minSuccessRate: 0.80,
      maxLatencyP99: 60000,
      minAvailability: 0.90
    }
  }
]
