/*
 * Gateway / billing-mode validation for payment-link creation.
 *
 * Shared by the admin route (paymentLinkController.create) and the portal route
 * (portalPaymentController.createPaymentLink) so both enforce the same rules:
 *
 *   - gateway is 'mastercard' (default) or 'stripe'
 *   - recurring billing is Stripe-only — the Mastercard hosted checkout used
 *     here does a single PURCHASE and stores no mandate
 *   - a recurring link never expires after a payment; every cycle is a new
 *     charge against the same link
 */

const GATEWAYS = ['mastercard', 'stripe']
const INTERVALS = ['day', 'week', 'month', 'year']

// Stripe's own ceiling per interval — reject before the API round-trip.
const MAX_INTERVAL_COUNT = { day: 365, week: 52, month: 12, year: 1 }

export function normalizeGatewayFields(body = {}) {
  const gateway = GATEWAYS.includes(body.gateway) ? body.gateway : 'mastercard'
  const paymentMode = body.paymentMode === 'recurring' ? 'recurring' : 'one_time'

  if (paymentMode === 'recurring' && gateway !== 'stripe') {
    return { error: 'Recurring payments require the Stripe gateway' }
  }

  const values = { gateway, paymentMode }

  if (paymentMode === 'recurring') {
    const r = body.recurring || {}
    const interval = INTERVALS.includes(r.interval) ? r.interval : 'month'
    const intervalCount = Math.max(1, Math.round(Number(r.intervalCount) || 1))
    if (intervalCount > MAX_INTERVAL_COUNT[interval]) {
      return { error: `Interval count for "${interval}" cannot exceed ${MAX_INTERVAL_COUNT[interval]}` }
    }
    const trialDays = Math.max(0, Math.round(Number(r.trialDays) || 0))
    if (trialDays > 730) return { error: 'Trial period cannot exceed 730 days' }

    values.recurring = { interval, intervalCount, trialDays }
    // A subscription bills forever — the link must stay open for every cycle.
    values.expiresAfterPayment = false
  }

  return { values }
}

/* Human label for a cycle, e.g. "monthly", "every 3 months". */
export function describeInterval({ interval = 'month', intervalCount = 1 } = {}) {
  const n = Math.max(1, Number(intervalCount) || 1)
  if (n === 1) return { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[interval] || `every ${interval}`
  return `every ${n} ${interval}s`
}
