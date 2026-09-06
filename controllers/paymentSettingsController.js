import PaymentSettings from '../models/PaymentSettings.js'
import { isStripeEnabled } from '../services/stripe.js'
import { logActivity } from '../utils/activityLogger.js'

/*
 * Which processor the public fee page checks out through.
 *
 * One row, key 'default'. Read on every /fee load (public) and edited from
 * Admin → Payment Settings. Payment links are NOT affected — those carry their
 * own `gateway` field chosen when the link is created.
 */

const GATEWAYS = ['mastercard', 'stripe']

export async function getSettingsDoc() {
  const existing = await PaymentSettings.findOne({ key: 'default' })
  if (existing) return existing
  return PaymentSettings.create({ key: 'default' })
}

/* The gateway the fee page can ACTUALLY use right now.
 * A 'stripe' setting on a deploy with no STRIPE_SECRET_KEY would render a Pay
 * button whose only possible answer is 503, so it degrades to Mastercard
 * rather than showing the payer a dead checkout. */
export async function resolveFeeGateway() {
  const settings = await getSettingsDoc().catch(() => null)
  const wanted = settings?.feeGateway || 'mastercard'
  if (wanted === 'stripe' && !isStripeEnabled()) return 'mastercard'
  return wanted
}

/* ── Public: what the fee page needs to know before rendering the modal ── */
export async function publicSettings(_req, res) {
  try {
    const feeGateway = await resolveFeeGateway()
    res.json({ feeGateway })
  } catch (err) {
    console.error('Payment settings public error:', err)
    // Never break the fee page over a settings read — fall back to the default.
    res.json({ feeGateway: 'mastercard' })
  }
}

/* ── Admin: read the stored setting (not the degraded one) ── */
export async function getSettings(_req, res) {
  try {
    const settings = await getSettingsDoc()
    res.json({
      feeGateway: settings.feeGateway,
      stripeConfigured: isStripeEnabled(),
      updatedAt: settings.updatedAt,
    })
  } catch (err) {
    console.error('Payment settings get error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: switch the fee page between gateways ── */
export async function updateSettings(req, res) {
  try {
    const { feeGateway } = req.body
    if (!GATEWAYS.includes(feeGateway)) {
      return res.status(400).json({ error: 'feeGateway must be "mastercard" or "stripe"' })
    }
    if (feeGateway === 'stripe' && !isStripeEnabled()) {
      return res.status(400).json({ error: 'Stripe is not configured on this server — set STRIPE_SECRET_KEY first' })
    }

    const settings = await getSettingsDoc()
    const previous = settings.feeGateway
    settings.feeGateway = feeGateway
    if (req.adminId) settings.updatedBy = req.adminId
    await settings.save()

    if (previous !== feeGateway) {
      logActivity({
        category: 'system',
        action: 'fee_gateway_changed',
        message: `Fee page payment gateway switched from ${previous} to ${feeGateway}`,
        req,
        meta: { previous, feeGateway },
      })
    }

    res.json({
      feeGateway: settings.feeGateway,
      stripeConfigured: isStripeEnabled(),
      updatedAt: settings.updatedAt,
    })
  } catch (err) {
    console.error('Payment settings update error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
