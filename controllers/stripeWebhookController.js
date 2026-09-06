import PaymentLink from '../models/PaymentLink.js'
import Payment from '../models/Payment.js'
import StripeEvent from '../models/StripeEvent.js'
import { constructWebhookEvent, retrieveCheckoutSession, retrieveSubscription, fromMinorUnits, periodEndOf } from '../services/stripe.js'
import { settleLinkPayment, buildPaymentData, generateInvoiceNo } from '../services/paymentLinkFulfillment.js'
import { applyStripeSessionRefs, applySubscriptionToLink } from './paymentLinkController.js'
import { settlePlanPaymentFromSession, finalizePlanPayment } from './paymentController.js'
import { logActivity } from '../utils/activityLogger.js'

/*
 * Stripe webhook — the authoritative source of payment truth.
 *
 * The browser return URL can be closed, blocked or never reached; Stripe's
 * webhook always arrives. It is also the ONLY signal for renewal charges, which
 * happen with no browser involved at all.
 *
 * Mounted in index.js with express.raw() BEFORE express.json(), because the
 * signature is computed over the exact bytes Stripe sent — a re-serialized JSON
 * body will never verify.
 *
 * Events handled:
 *   checkout.session.completed      first charge / subscription activated
 *   invoice.paid                    a renewal cycle succeeded  ← recurring money
 *   invoice.payment_failed          a renewal cycle failed
 *   customer.subscription.updated   status / cancel-at-period-end changes
 *   customer.subscription.deleted   subscription ended
 *   charge.refunded                 money returned
 */

export async function stripeWebhook(req, res) {
  let event
  try {
    event = constructWebhookEvent(req.body, req.headers['stripe-signature'])
  } catch (err) {
    // Bad signature or missing secret — never process, never retry.
    console.error('Stripe webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // Claim the event before doing any work. A duplicate delivery loses the race
  // on the unique index and returns 200 without re-charging anything.
  try {
    await StripeEvent.create({ eventId: event.id, type: event.type })
  } catch (err) {
    if (err?.code === 11000) return res.json({ received: true, duplicate: true })
    console.error('Stripe webhook ledger error:', err.message)
    return res.status(500).send('Ledger error')
  }

  // Acknowledge fast — Stripe times out at 20s and starts retrying. The handler
  // runs after the response; failures are recorded on the ledger row.
  res.json({ received: true })

  try {
    await handleEvent(event)
    await StripeEvent.updateOne({ eventId: event.id }, { status: 'done' })
  } catch (err) {
    console.error(`Stripe webhook handler error (${event.type}):`, err)
    await StripeEvent.updateOne({ eventId: event.id }, { status: 'error', error: String(err?.message || err).slice(0, 500) })
      .catch(() => {})
  }
}

async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return onCheckoutCompleted(event.data.object)
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return onCheckoutFailed(event.data.object)
    case 'invoice.paid':
      return onInvoicePaid(event.data.object)
    case 'invoice.payment_failed':
      return onInvoiceFailed(event.data.object)
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return onSubscriptionChanged(event.data.object)
    case 'charge.refunded':
      return onChargeRefunded(event.data.object)
    default:
      return undefined
  }
}

/* ── First charge / subscription activation ── */
async function onCheckoutCompleted(sessionLite) {
  // Expand so we get the subscription object (status, period end), not just an id.
  const session = await retrieveCheckoutSession(sessionLite.id).catch(() => sessionLite)

  const link = await findLink(session)
  // No link behind the session → a fee-page plan purchase (/api/payments/
  // initiate-stripe), which settles against the Payment document alone.
  if (!link) {
    await settlePlanPaymentFromSession(session, { source: 'stripe_webhook' })
    return
  }

  if (session.mode === 'subscription' && session.subscription) {
    await applySubscriptionToLink(link, session)
  }

  const payment = await findSessionPayment(session)
  if (!payment) return

  // For subscriptions, `invoice.paid` carries the real amount and invoice id and
  // fires alongside this event — let it settle the money so the two handlers
  // can't both record the first cycle. Here we only bind the subscription.
  if (session.mode === 'subscription') return

  const alreadySettled = payment.status === 'completed'
  payment.status = 'completed'
  payment.gatewayResult = 'SUCCESS'
  applyStripeSessionRefs(payment, session)

  await settleLinkPayment({ link, payment, alreadySettled, source: 'stripe_webhook' })
}

async function onCheckoutFailed(session) {
  const payment = await findSessionPayment(session)
  if (!payment || payment.status === 'completed') return

  const link = await findLink(session)
  payment.status = session.status === 'expired' ? 'expired' : 'failed'
  payment.gatewayResult = session.status === 'expired' ? 'SESSION_EXPIRED' : 'PAYMENT_FAILED'
  applyStripeSessionRefs(payment, session)

  if (!link) {
    // Fee-page plan purchase. An expired session is just an abandoned
    // checkout — record it, but don't email anyone about it.
    if (payment.status === 'expired') { await payment.save(); return }
    await finalizePlanPayment({ payment, source: 'stripe_webhook' })
    return
  }
  await settleLinkPayment({ link, payment, source: 'stripe_webhook' })
}

/* ── A subscription invoice was paid — this is the recurring money ──
 * Fires for the first cycle AND every renewal. Each invoice becomes its own
 * Payment row; the unique partial index on stripeInvoiceId makes that safe. */
async function onInvoicePaid(invoice) {
  const subscriptionId = subIdOf(invoice)
  if (!subscriptionId) return // not a subscription invoice — nothing to record

  const link = await findSubscriptionLink(subscriptionId)
  if (!link) return

  const existing = await Payment.findOne({ stripeInvoiceId: invoice.id })
  const amount = fromMinorUnits(invoice.amount_paid ?? invoice.total ?? 0, invoice.currency)
  const isFirstCycle = invoice.billing_reason === 'subscription_create'

  // The first cycle reuses the placeholder Payment created at checkout so the
  // link doesn't end up with a stray pending row; renewals always get a new one.
  let payment = existing
  if (!payment && isFirstCycle && link.payment) {
    const placeholder = await Payment.findById(link.payment)
    if (placeholder && placeholder.gateway === 'stripe' && placeholder.status === 'pending') payment = placeholder
  }

  if (!payment) {
    // A renewal: no browser, no discount, no placeholder — mint a fresh invoice
    // number so this cycle is its own auditable document.
    const invoiceNo = link.invoiceNo || await generateInvoiceNo()
    payment = new Payment(buildPaymentData(link, {
      orderId: `SUB-${invoice.id}`,
      finalAmount: amount,
      taxAmount: 0,
      appliedDiscount: null,
      gateway: 'stripe',
      paymentMethod: 'STRIPE',
    }))
    payment.invoiceNo = invoiceNo
  }

  const alreadySettled = payment.status === 'completed'

  payment.amount = amount
  payment.currency = String(invoice.currency || link.currency || 'PKR').toUpperCase()
  payment.status = 'completed'
  payment.gateway = 'stripe'
  payment.paymentMethod = 'STRIPE'
  payment.gatewayResult = 'SUCCESS'
  payment.stripeInvoiceId = invoice.id
  payment.stripeSubscriptionId = subscriptionId
  payment.billingReason = invoice.billing_reason || (isFirstCycle ? 'subscription_create' : 'subscription_cycle')
  const pi = paymentIntentIdOf(invoice)
  if (pi) {
    payment.stripePaymentIntentId = pi
    payment.gatewayTransactionId = pi
  }
  if (!payment.gatewayOrderId) payment.gatewayOrderId = `SUB-${invoice.id}`

  await settleLinkPayment({ link, payment, alreadySettled, source: 'stripe_webhook_invoice' })
}

async function onInvoiceFailed(invoice) {
  const subscriptionId = subIdOf(invoice)
  if (!subscriptionId) return

  const link = await findSubscriptionLink(subscriptionId)
  if (!link) return

  // Don't create a Payment row for a failed renewal — Stripe retries on its own
  // dunning schedule, and a row per attempt would pollute the ledger. Record the
  // state on the link and raise it in the activity log instead.
  link.subscriptionStatus = 'past_due'
  await link.save()

  logActivity({
    level: 'warning',
    category: 'payment_link',
    action: 'subscription_payment_failed',
    message: `Subscription renewal failed — ${String(invoice.currency || '').toUpperCase()} ${fromMinorUnits(invoice.amount_due || 0, invoice.currency)} for ${link.payeeName || 'unknown'}`,
    meta: {
      linkId: link._id,
      subscriptionId,
      stripeInvoiceId: invoice.id,
      attemptCount: invoice.attempt_count,
      nextAttempt: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null,
    },
  })
}

async function onSubscriptionChanged(subscription) {
  const link = await findSubscriptionLink(subscription.id, subscription)
  if (!link) return

  link.subscriptionStatus = subscription.status || ''
  link.subscriptionCancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end)
  const periodEnd = periodEndOf(subscription)
  if (periodEnd) link.subscriptionCurrentPeriodEnd = periodEnd
  // A dead subscription closes the link so the pay page stops offering checkout.
  if (['canceled', 'incomplete_expired'].includes(subscription.status)) {
    link.status = link.payments?.length ? 'completed' : 'failed'
  }
  await link.save()

  logActivity({
    level: 'info',
    category: 'payment_link',
    action: 'subscription_updated',
    message: `Subscription ${subscription.status} for ${link.payeeName || 'unknown'}`,
    meta: { linkId: link._id, subscriptionId: subscription.id, status: subscription.status },
  })
}

async function onChargeRefunded(charge) {
  const payment = await Payment.findOne({ stripePaymentIntentId: charge.payment_intent })
  if (!payment) return

  const refundedAll = charge.amount_refunded >= charge.amount
  payment.status = refundedAll ? 'refunded' : payment.status
  payment.gatewayResult = refundedAll ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
  await payment.save()

  logActivity({
    level: 'warning',
    category: 'payment_link',
    action: 'payment_refunded',
    message: `Refund ${refundedAll ? 'in full' : 'partial'} — ${payment.currency} ${fromMinorUnits(charge.amount_refunded, charge.currency)} to ${payment.studentName || 'unknown'}`,
    meta: { paymentId: payment._id, chargeId: charge.id, amountRefunded: charge.amount_refunded },
  })
}

/* ── helpers ── */

/* Resolve the link behind a subscription.
 *
 * Stripe does NOT guarantee event ordering: `invoice.paid` for the first cycle
 * can land BEFORE `checkout.session.completed` has written the subscription id
 * onto the link. When the id lookup misses, fall back to the subscription's own
 * metadata (set from `subscription_data.metadata` at checkout) and bind the id
 * then — otherwise that first cycle would be silently dropped. */
async function findSubscriptionLink(subscriptionId, known = null) {
  const byId = await PaymentLink.findOne({ stripeSubscriptionId: subscriptionId })
  if (byId) return byId

  const sub = known || await retrieveSubscription(subscriptionId).catch(() => null)
  const linkId = sub?.metadata?.paymentLinkId
  if (!linkId) return null

  const link = await PaymentLink.findById(linkId).catch(() => null)
  if (!link) return null

  link.stripeSubscriptionId = subscriptionId
  if (sub.customer) link.stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  if (!link.subscriptionStatus) link.subscriptionStatus = sub.status || 'active'
  await link.save()
  return link
}

async function findLink(session) {
  const id = session.metadata?.paymentLinkId || session.client_reference_id
  if (id) {
    const byId = await PaymentLink.findById(id).catch(() => null)
    if (byId) return byId
  }
  if (session.metadata?.token) return PaymentLink.findOne({ token: session.metadata.token })
  return null
}

async function findSessionPayment(session) {
  if (session.metadata?.paymentId) {
    const byId = await Payment.findById(session.metadata.paymentId).catch(() => null)
    if (byId) return byId
  }
  return Payment.findOne({ stripeSessionId: session.id })
}

// The subscription/payment_intent reference moved into `invoice.parent` in
// newer API versions — read both shapes so the handler survives either.
function subIdOf(invoice) {
  const raw = invoice.subscription
    ?? invoice.parent?.subscription_details?.subscription
    ?? null
  if (!raw) return null
  return typeof raw === 'string' ? raw : raw.id
}

function paymentIntentIdOf(invoice) {
  const raw = invoice.payment_intent
    ?? invoice.payments?.data?.[0]?.payment?.payment_intent
    ?? null
  if (!raw) return null
  return typeof raw === 'string' ? raw : raw.id
}
