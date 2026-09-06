import Stripe from 'stripe'

/*
 * Stripe integration — hosted Checkout only.
 *
 * We never touch card data: every payment is a redirect to a Stripe-hosted
 * Checkout page, and the authoritative result arrives on the webhook
 * (`/api/stripe/webhook`). The browser return URL is only a convenience
 * re-sync so the payer sees a confirmed receipt without waiting for the hook.
 *
 * Two modes:
 *   - mode: 'payment'      → one-off charge (mirrors the Mastercard flow)
 *   - mode: 'subscription' → recurring billing; Stripe stores the mandate and
 *                            charges every interval, emitting `invoice.paid`.
 */

let client = null

export function isStripeEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

export function stripe() {
  if (!isStripeEnabled()) {
    throw new Error('Stripe is not configured — set STRIPE_SECRET_KEY in .env')
  }
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY, {
      // Let the SDK use its pinned API version; only tag the app for Stripe logs.
      appInfo: { name: 'Hidaya Online', url: process.env.FRONTEND_URL || '' },
      maxNetworkRetries: 2,
    })
  }
  return client
}

/* ── Currency unit conversion ──
 * Stripe takes amounts in the currency's smallest unit. Most currencies are
 * 2-decimal (PKR/USD/EUR/GBP/CAD all are), but the zero-decimal list must never
 * be multiplied by 100 or the customer is charged 100×. */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND'])

export function toMinorUnits(amount, currency) {
  const cur = String(currency || 'PKR').toUpperCase()
  const val = Number(amount) || 0
  if (ZERO_DECIMAL.has(cur)) return Math.round(val)
  if (THREE_DECIMAL.has(cur)) return Math.round(val * 1000)
  return Math.round(val * 100)
}

export function fromMinorUnits(minor, currency) {
  const cur = String(currency || 'PKR').toUpperCase()
  const val = Number(minor) || 0
  if (ZERO_DECIMAL.has(cur)) return val
  if (THREE_DECIMAL.has(cur)) return val / 1000
  return val / 100
}

/* ── One-off hosted Checkout session ── */
export async function createCheckoutSession({
  amount, currency, description, items = [],
  successUrl, cancelUrl,
  customerName, customerEmail,
  metadata = {}, clientReferenceId,
}) {
  return stripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: String(currency || 'PKR').toLowerCase(),
        unit_amount: toMinorUnits(amount, currency),
        product_data: {
          name: description || 'Hidaya Online',
          ...(items.length > 0 && { description: items.join(' · ').slice(0, 500) }),
        },
      },
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    ...(clientReferenceId ? { client_reference_id: clientReferenceId } : {}),
    metadata: { ...metadata, ...(customerName ? { payeeName: customerName } : {}) },
    // Mirrors the Mastercard flow, which collects the billing address.
    billing_address_collection: 'required',
    payment_intent_data: {
      description: `Hidaya Online — ${description || 'Payment'}`,
      metadata,
    },
  })
}

/* ── Recurring hosted Checkout session (subscription) ──
 * `interval` is one of day|week|month|year; `intervalCount` how many of them
 * per cycle (e.g. month × 3 = quarterly). `discountCouponId` applies to the
 * FIRST invoice only — see createOnceOffCoupon below. */
export async function createSubscriptionSession({
  amount, currency, description, items = [],
  interval = 'month', intervalCount = 1, trialDays = 0,
  successUrl, cancelUrl,
  customerName, customerEmail,
  metadata = {}, clientReferenceId, discountCouponId,
}) {
  return stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: String(currency || 'PKR').toLowerCase(),
        unit_amount: toMinorUnits(amount, currency),
        recurring: { interval, interval_count: Math.max(1, Number(intervalCount) || 1) },
        product_data: {
          name: description || 'Hidaya Online',
          ...(items.length > 0 && { description: items.join(' · ').slice(0, 500) }),
        },
      },
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    ...(clientReferenceId ? { client_reference_id: clientReferenceId } : {}),
    ...(discountCouponId ? { discounts: [{ coupon: discountCouponId }] } : {}),
    metadata,
    billing_address_collection: 'required',
    subscription_data: {
      description: `Hidaya Online — ${description || 'Subscription'}`,
      ...(Number(trialDays) > 0 ? { trial_period_days: Math.round(Number(trialDays)) } : {}),
      metadata,
    },
  })
}

/* ── First-cycle-only discount for subscriptions ──
 * A discount code shouldn't silently repeat forever on a recurring link, so it
 * becomes a `duration: 'once'` coupon that Stripe burns on the first invoice. */
export async function createOnceOffCoupon({ amountOff, currency, name }) {
  return stripe().coupons.create({
    amount_off: toMinorUnits(amountOff, currency),
    currency: String(currency || 'PKR').toLowerCase(),
    duration: 'once',
    ...(name ? { name: String(name).slice(0, 40) } : {}),
    max_redemptions: 1,
  })
}

export async function retrieveCheckoutSession(sessionId, expand = ['payment_intent', 'subscription']) {
  return stripe().checkout.sessions.retrieve(sessionId, { expand })
}

export async function retrieveSubscription(subscriptionId) {
  return stripe().subscriptions.retrieve(subscriptionId)
}

/* ── When does the current billing period end? ──
 * Recent API versions moved `current_period_end` off the Subscription and onto
 * its items, so read both shapes rather than silently storing null. */
export function periodEndOf(subscription) {
  if (!subscription || typeof subscription === 'string') return null
  const ts = subscription.current_period_end
    ?? subscription.items?.data?.[0]?.current_period_end
    ?? null
  return ts ? new Date(ts * 1000) : null
}

/* Cancel at period end by default so the payer keeps what they already paid for. */
export async function cancelSubscription(subscriptionId, { immediately = false } = {}) {
  if (immediately) return stripe().subscriptions.cancel(subscriptionId)
  return stripe().subscriptions.update(subscriptionId, { cancel_at_period_end: true })
}

/* ── Webhook signature verification ──
 * `rawBody` MUST be the untouched Buffer — the route is mounted with
 * express.raw() ahead of express.json() in index.js for exactly this reason. */
export function constructWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set')
  return stripe().webhooks.constructEvent(rawBody, signature, secret)
}
