/**
 * Cross-chain mirror status API endpoints
 */

import { Router } from 'express'
import { bridgeMonitor } from '../services/bridge-monitor'

const router = Router()

/**
 * GET /mirror/status
 * Get current mirror status and lag information
 */
router.get('/status', (req, res) => {
  try {
    const status = bridgeMonitor.getStatus()
    res.json({
      success: true,
      data: status
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    })
  }
})

/**
 * GET /mirror/lag
 * Get mirror lag metrics
 */
router.get('/lag', (req, res) => {
  try {
    const lag = bridgeMonitor.getMirrorLag()
    res.json({
      success: true,
      data: lag
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    })
  }
})

/**
 * GET /mirror/divergence
 * Check for state divergence between chains
 */
router.get('/divergence', (req, res) => {
  try {
    const divergence = bridgeMonitor.checkDivergence()
    res.json({
      success: true,
      data: divergence
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    })
  }
})

/**
 * POST /mirror/trigger
 * Manually trigger a mirror operation
 */
router.post('/trigger', async (req, res) => {
  try {
    const { type } = req.body

    if (!type || !['membership', 'proposal'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid mirror type. Must be "membership" or "proposal"'
      })
    }

    await bridgeMonitor.triggerMirror(type)

    res.json({
      success: true,
      message: `${type} mirror triggered successfully`
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    })
  }
})

export default router
