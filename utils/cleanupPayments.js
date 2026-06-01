import Payment from '../models/Payment.js'

const STALE_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour

export async function cleanupStalePayments() {
  try {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS)
    const result = await Payment.updateMany(
      { status: 'pending', createdAt: { $lt: cutoff } },
      { $set: { status: 'expired', gatewayResult: 'EXPIRED_STALE' } }
    )
    if (result.modifiedCount > 0) {
      console.log(`[cleanup] Marked ${result.modifiedCount} stale pending payment(s) as expired`)
    }
  } catch (err) {
    console.error('[cleanup] Failed to clean stale payments:', err.message)
  }
}

export function startPaymentCleanupJob() {
  // Run immediately on startup
  cleanupStalePayments()

  // Then run every hour
  setInterval(cleanupStalePayments, 60 * 60 * 1000)
  console.log('[cleanup] Payment cleanup job scheduled (every 1 hour)')
}
