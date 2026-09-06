import PaymentLink from '../models/PaymentLink.js'
import Payment from '../models/Payment.js'
import { createCheckoutSession, initiateBrowserPayment, retrieveOrder } from '../services/mastercard.js'
import {
  isStripeEnabled,
  createCheckoutSession as createStripeCheckoutSession,
  createSubscriptionSession as createStripeSubscriptionSession,
  createOnceOffCoupon,
  retrieveCheckoutSession,
  periodEndOf,
} from '../services/stripe.js'
import {
  generateInvoiceNo,
  priceLinkCharge,
  buildPaymentData,
  settleLinkPayment,
  expirePendingPayment,
} from '../services/paymentLinkFulfillment.js'
import { normalizeGatewayFields } from '../utils/paymentLinkOptions.js'
import { paymentLinkEmail, paymentLinkAdminEmail, notifyAdmin, sendToUser } from '../services/mailer.js'

/* ── Admin: Create a payment link ── */
export async function create(req, res) {
  try {
    const { payeeName, payeeEmail, payeePhone, description, amount, currency, notes, expiresAfterPayment, items, listType, student, taxType, taxValue } = req.body
    if (!payeeName || !description || !amount) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const validCurrencies = ['PKR', 'USD', 'EUR', 'GBP', 'CAD']
    const invoiceNo = await generateInvoiceNo()

    const normalizedTaxType = ['percentage', 'fixed'].includes(taxType) ? taxType : 'none'

    // gateway / paymentMode / recurring — validated together (recurring is
    // Stripe-only and always leaves the link reusable).
    const gatewayFields = normalizeGatewayFields(req.body)
    if (gatewayFields.error) return res.status(400).json({ error: gatewayFields.error })

    const linkData = {
      payeeName,
      payeeEmail,
      payeePhone,
      description,
      amount: Number(amount),
      currency: validCurrencies.includes(currency) ? currency : 'PKR',
      taxType: normalizedTaxType,
      taxValue: normalizedTaxType === 'none' ? 0 : Math.max(0, Number(taxValue) || 0),
      notes,
      expiresAfterPayment: expiresAfterPayment !== false,
      items: Array.isArray(items) ? items.filter(i => i.trim()) : [],
      listType: listType === 'numbered' ? 'numbered' : 'bullet',
      invoiceNo,
      ...gatewayFields.values,
    }
    if (student) linkData.student = student

    const link = await PaymentLink.create(linkData)

    res.status(201).json(link)
  } catch (err) {
    console.error('PaymentLink create error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Send payment link email ── */
export async function sendEmail(req, res) {
  try {
    const link = await PaymentLink.findById(req.params.id)
    if (!link) return res.status(404).json({ error: 'Payment link not found' })

    const email = paymentLinkEmail(link.toObject())
    await sendToUser({ to: link.payeeEmail, ...email })

    link.emailSent = true
    await link.save()

    // Notify admin too
    notifyAdmin(paymentLinkAdminEmail(link.toObject())).catch(() => {})

    res.json({ success: true })
  } catch (err) {
    console.error('PaymentLink sendEmail error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: List payment links ── */
export async function list(req, res) {
  try {
    const { status, startDate, endDate, search } = req.query
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const filter = {}
    if (status) filter.status = status
    if (startDate || endDate) {
      filter.createdAt = {}
      if (startDate) filter.createdAt.$gte = new Date(startDate)
      if (endDate) filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999))
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [
        { payeeName: regex },
        { payeeEmail: regex },
        { payeePhone: regex },
        { description: regex },
        { notes: regex },
        { invoiceNo: regex },
      ]
      const num = Number(search)
      if (!isNaN(num)) filter.$or.push({ amount: num })
    }

    const total = await PaymentLink.countDocuments(filter)
    const pages = Math.max(1, Math.ceil(total / lim))
    const safePage = Math.min(pg, pages)
    const links = await PaymentLink.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .populate('student', 'name email rollNo')

    res.json({ links, total, page: safePage, pages })
  } catch (err) {
    console.error('PaymentLink list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Get stats ── */
export async function getStats(req, res) {
  try {
    const { startDate, endDate } = req.query
    const dateFilter = {}
    if (startDate || endDate) {
      dateFilter.createdAt = {}
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate)
      if (endDate) dateFilter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999))
    }

    const [total, active, completed, failed] = await Promise.all([
      PaymentLink.countDocuments(dateFilter),
      PaymentLink.countDocuments({ status: 'active', ...dateFilter }),
      PaymentLink.countDocuments({ status: 'completed', ...dateFilter }),
      PaymentLink.countDocuments({ status: 'failed', ...dateFilter }),
    ])

    const revenueResult = await PaymentLink.aggregate([
      { $match: { status: 'completed', ...dateFilter } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ])
    const totalCollected = revenueResult[0]?.total || 0

    const recent = await PaymentLink.find(dateFilter).sort({ createdAt: -1 }).limit(5)

    res.json({ total, active, completed, failed, totalCollected, recent })
  } catch (err) {
    console.error('PaymentLink stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Get payment history for a link ── */
export async function getPaymentHistory(req, res) {
  try {
    const link = await PaymentLink.findById(req.params.id)
      .populate('student', 'name email rollNo phone')
    if (!link) return res.status(404).json({ error: 'Payment link not found' })

    const payments = await Payment.find({ paymentLink: link._id })
      .sort({ createdAt: -1 })

    const completed = payments.filter(p => p.status === 'completed')
    const totalPaid = completed.reduce((sum, p) => sum + (p.amount || 0), 0)

    res.json({
      link,
      payments,
      stats: {
        totalPayments: payments.length,
        completedPayments: completed.length,
        pendingPayments: payments.filter(p => p.status === 'pending').length,
        failedPayments: payments.filter(p => p.status === 'failed').length,
        totalPaid,
      },
    })
  } catch (err) {
    console.error('PaymentLink getPaymentHistory error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Delete a payment link ── */
export async function remove(req, res) {
  try {
    const link = await PaymentLink.findByIdAndDelete(req.params.id)
    if (!link) return res.status(404).json({ error: 'Payment link not found' })
    res.json({ success: true })
  } catch (err) {
    console.error('PaymentLink delete error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Public: Get payment link by token ── */
export async function getByToken(req, res) {
  try {
    const link = await PaymentLink.findOne({ token: req.params.token })
    if (!link) return res.status(404).json({ error: 'Payment link not found' })

    res.json({
      payeeName: link.payeeName,
      payeeEmail: link.payeeEmail,
      description: link.description,
      amount: link.amount,
      currency: link.currency,
      taxType: link.taxType || 'none',
      taxValue: link.taxValue || 0,
      status: link.status,
      token: link.token,
      expiresAfterPayment: link.expiresAfterPayment,
      items: link.items || [],
      listType: link.listType || 'bullet',
      invoiceNo: link.invoiceNo,
      // Which checkout the pay page should render
      gateway: link.gateway || 'mastercard',
      paymentMode: link.paymentMode || 'one_time',
      recurring: link.paymentMode === 'recurring'
        ? {
          interval: link.recurring?.interval || 'month',
          intervalCount: link.recurring?.intervalCount || 1,
          trialDays: link.recurring?.trialDays || 0,
        }
        : null,
      subscriptionStatus: link.subscriptionStatus || '',
    })
  } catch (err) {
    console.error('PaymentLink getByToken error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Public: Initiate a Mastercard payment from link ── */
export async function initiate(req, res) {
  try {
    const link = await PaymentLink.findOne({ token: req.params.token })
    if (!link) return res.status(404).json({ error: 'Payment link not found' })
    if (link.status === 'completed') {
      return res.status(400).json({ error: 'This payment link has already been used' })
    }
    if (link.paymentMode === 'recurring') {
      return res.status(400).json({ error: 'This is a recurring link — use the Stripe checkout' })
    }

    await expirePendingPayment(link)

    const pricing = await priceLinkCharge(link, req.body.discountCode)
    if (pricing.error) return res.status(400).json({ error: pricing.error })
    const { finalAmount, taxAmount, appliedDiscount } = pricing

    const orderId = `PL-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const payment = await Payment.create(buildPaymentData(link, {
      orderId, finalAmount, taxAmount, appliedDiscount,
      gateway: 'mastercard', paymentMethod: 'CARD',
    }))

    // Link the payment to the payment link
    link.payment = payment._id
    await link.save()

    const sessionData = await createCheckoutSession({
      orderId,
      amount: finalAmount,
      currency: link.currency || 'PKR',
      plan: link.description,
      returnUrl: `${process.env.FRONTEND_URL}/pay/${link.token}/callback?orderId=${orderId}`,
      cancelUrl: `${process.env.FRONTEND_URL}/pay/${link.token}`,
      customerName: link.payeeName,
      customerEmail: link.payeeEmail || undefined,
    })

    if (sessionData.session?.id) {
      res.json({
        sessionId: sessionData.session.id,
        orderId,
        paymentId: payment._id,
        merchantId: process.env.MC_MERCHANT_ID,
        checkoutBaseUrl: process.env.MC_GATEWAY_URL,
      })
    } else {
      payment.status = 'failed'
      payment.gatewayResult = sessionData.result || 'SESSION_FAILED'
      await payment.save()
      res.status(400).json({ error: 'Failed to create checkout session', details: sessionData })
    }
  } catch (err) {
    console.error('PaymentLink initiate error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Public: Initiate PayPal payment from link ── */
export async function initiatePayPal(req, res) {
  try {
    const link = await PaymentLink.findOne({ token: req.params.token })
    if (!link) return res.status(404).json({ error: 'Payment link not found' })
    if (link.status === 'completed') {
      return res.status(400).json({ error: 'This payment link has already been used' })
    }

    const currency = link.currency || 'PKR'
    if (currency === 'PKR') {
      return res.status(400).json({ error: 'PayPal is not available for PKR payments' })
    }
    if (link.paymentMode === 'recurring') {
      return res.status(400).json({ error: 'This is a recurring link — use the Stripe checkout' })
    }

    await expirePendingPayment(link)

    const pricing = await priceLinkCharge(link, req.body.discountCode)
    if (pricing.error) return res.status(400).json({ error: pricing.error })
    const { finalAmount, taxAmount, appliedDiscount } = pricing

    const orderId = `PL-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const payment = await Payment.create(buildPaymentData(link, {
      orderId, finalAmount, taxAmount, appliedDiscount,
      gateway: 'mastercard', paymentMethod: 'PAYPAL',
    }))
    link.payment = payment._id
    await link.save()

    const result = await initiateBrowserPayment({
      orderId,
      transactionId,
      amount: finalAmount,
      currency,
      plan: link.description,
      returnUrl: `${process.env.FRONTEND_URL}/pay/${link.token}/callback?orderId=${orderId}`,
    })

    if (result.browserPayment?.redirectUrl) {
      res.json({
        redirectUrl: result.browserPayment.redirectUrl,
        orderId,
        paymentId: payment._id,
      })
    } else {
      payment.status = 'failed'
      payment.gatewayResult = result.result || 'PAYPAL_INIT_FAILED'
      await payment.save()
      res.status(400).json({ error: 'Failed to initiate PayPal payment', details: result })
    }
  } catch (err) {
    console.error('PaymentLink initiatePayPal error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Public: Initiate a Stripe hosted-checkout payment from link ──
 * Handles BOTH billing modes. A one-off link opens a `mode: 'payment'` session;
 * a recurring link opens `mode: 'subscription'`, which is what makes Stripe
 * store the mandate and keep charging every cycle.
 *
 * The Payment row created here is a placeholder for the FIRST charge only.
 * Every subsequent cycle gets its own Payment row, created by the webhook when
 * Stripe emits `invoice.paid` — nothing is recorded here optimistically. */
export async function initiateStripe(req, res) {
  try {
    if (!isStripeEnabled()) {
      return res.status(503).json({ error: 'Stripe payments are not configured' })
    }

    const link = await PaymentLink.findOne({ token: req.params.token })
    if (!link) return res.status(404).json({ error: 'Payment link not found' })
    if (link.status === 'completed') {
      return res.status(400).json({ error: 'This payment link has already been used' })
    }
    if (link.paymentMode === 'recurring' && link.stripeSubscriptionId &&
        ['active', 'trialing', 'past_due'].includes(link.subscriptionStatus)) {
      return res.status(400).json({ error: 'A subscription is already active on this link' })
    }

    await expirePendingPayment(link)

    const pricing = await priceLinkCharge(link, req.body.discountCode)
    if (pricing.error) return res.status(400).json({ error: pricing.error })
    const { subtotal, finalAmount, taxAmount, appliedDiscount } = pricing

    const isRecurring = link.paymentMode === 'recurring'
    const orderId = `PL-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const payment = await Payment.create(buildPaymentData(link, {
      orderId,
      // A subscription's recurring price is the UNDISCOUNTED total; the discount
      // rides along as a one-off coupon on the first invoice (see below), so the
      // placeholder still records what this first charge is expected to be.
      finalAmount, taxAmount, appliedDiscount,
      gateway: 'stripe', paymentMethod: 'STRIPE',
    }))
    if (isRecurring) payment.billingReason = 'subscription_create'
    await payment.save()

    link.payment = payment._id
    await link.save()

    const successUrl = `${process.env.FRONTEND_URL}/pay/${link.token}/callback?provider=stripe&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${process.env.FRONTEND_URL}/pay/${link.token}`
    const metadata = {
      paymentLinkId: String(link._id),
      paymentId: String(payment._id),
      orderId,
      invoiceNo: link.invoiceNo || '',
      token: link.token,
    }

    let session
    if (isRecurring) {
      // Recurring price = amount + tax, charged every cycle. A discount code
      // becomes a `duration: 'once'` coupon so it can't silently repeat forever.
      const recurringAmount = link.amount + computeTaxForLink(link, link.amount)
      let discountCouponId
      if (appliedDiscount) {
        const coupon = await createOnceOffCoupon({
          amountOff: appliedDiscount.discountAmount,
          currency: link.currency || 'PKR',
          name: appliedDiscount.code,
        })
        discountCouponId = coupon.id
      }

      session = await createStripeSubscriptionSession({
        amount: recurringAmount,
        currency: link.currency || 'PKR',
        description: link.description,
        items: link.items || [],
        interval: link.recurring?.interval || 'month',
        intervalCount: link.recurring?.intervalCount || 1,
        trialDays: link.recurring?.trialDays || 0,
        successUrl, cancelUrl,
        customerName: link.payeeName,
        customerEmail: link.payeeEmail || undefined,
        metadata,
        clientReferenceId: String(link._id),
        discountCouponId,
      })
    } else {
      session = await createStripeCheckoutSession({
        amount: finalAmount,
        currency: link.currency || 'PKR',
        description: link.description,
        items: link.items || [],
        successUrl, cancelUrl,
        customerName: link.payeeName,
        customerEmail: link.payeeEmail || undefined,
        metadata,
        clientReferenceId: String(link._id),
      })
    }

    payment.stripeSessionId = session.id
    await payment.save()

    // Hosted checkout — the browser goes to Stripe's page.
    res.json({
      url: session.url,
      sessionId: session.id,
      orderId,
      paymentId: payment._id,
      mode: isRecurring ? 'subscription' : 'payment',
      subtotal,
    })
  } catch (err) {
    console.error('PaymentLink initiateStripe error:', err)
    res.status(500).json({ error: err?.message || 'Failed to start Stripe checkout' })
  }
}

/* Tax on a raw (pre-discount) amount for this link — used for the recurring price. */
function computeTaxForLink(link, amount) {
  const val = Number(link.taxValue) || 0
  if (link.taxType === 'percentage') return Math.round(amount * (val / 100) * 100) / 100
  if (link.taxType === 'fixed') return Math.max(0, val)
  return 0
}

/* ── Public: Payment callback for link ──
 * Mastercard posts `{ orderId }`; Stripe's return URL posts `{ sessionId }`.
 *
 * For Stripe this is only a convenience re-sync so the payer sees a confirmed
 * receipt immediately — the webhook is the authority and may well have landed
 * first. Both paths funnel through settleLinkPayment(), which is idempotent. */
export async function callback(req, res) {
  try {
    const { token } = req.params
    const { orderId, sessionId } = req.body

    const link = await PaymentLink.findOne({ token })
    if (!link) return res.status(404).json({ error: 'Payment link not found' })

    if (sessionId) return stripeCallback({ req, res, link, sessionId })

    if (!orderId) return res.status(400).json({ error: 'Order ID required' })

    const payment = await Payment.findOne({ gatewayOrderId: orderId })
    if (!payment) return res.status(404).json({ error: 'Payment not found' })

    const alreadySettled = payment.status === 'completed'
    const orderData = await retrieveOrder(orderId)

    if (orderData.result === 'SUCCESS' && orderData.status === 'CAPTURED') {
      payment.status = 'completed'
      payment.gatewayResult = 'SUCCESS'
      payment.gatewayTransactionId = orderData.transaction?.[0]?.transaction?.id || ''
      payment.gatewayResultCode = orderData.transaction?.[0]?.response?.gatewayCode || ''
    } else if (orderData.result === 'SUCCESS') {
      payment.status = 'completed'
      payment.gatewayResult = orderData.status || 'SUCCESS'
    } else {
      payment.status = 'failed'
      payment.gatewayResult = orderData.result || 'FAILED'
      payment.gatewayResultCode = orderData.error?.cause || ''
    }

    await settleLinkPayment({ link, payment, req, alreadySettled, source: 'mastercard_callback' })

    res.json({ status: payment.status, payment })
  } catch (err) {
    console.error('PaymentLink callback error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* Stripe return-URL re-sync — reads the session straight from Stripe rather
 * than trusting the query string. */
async function stripeCallback({ req, res, link, sessionId }) {
  if (!isStripeEnabled()) return res.status(503).json({ error: 'Stripe payments are not configured' })

  const session = await retrieveCheckoutSession(sessionId)
  if (!session || String(session.metadata?.paymentLinkId || '') !== String(link._id)) {
    return res.status(404).json({ error: 'Checkout session not found for this link' })
  }

  const payment = await Payment.findOne({ stripeSessionId: sessionId })
  if (!payment) return res.status(404).json({ error: 'Payment not found' })

  const alreadySettled = payment.status === 'completed'

  // `paid` covers one-off sessions; a subscription session with a 100%-trial
  // start is 'no_payment_required' but still a successful activation.
  const ok = session.payment_status === 'paid' || session.payment_status === 'no_payment_required'

  if (ok) {
    payment.status = 'completed'
    payment.gatewayResult = 'SUCCESS'
    applyStripeSessionRefs(payment, session)
  } else if (session.status === 'expired') {
    payment.status = 'failed'
    payment.gatewayResult = 'SESSION_EXPIRED'
  } else {
    // Still 'open' / processing — leave it pending and let the webhook decide.
    await payment.save()
    return res.json({ status: payment.status, payment })
  }

  if (session.mode === 'subscription' && session.subscription) {
    await applySubscriptionToLink(link, session)
  }

  await settleLinkPayment({ link, payment, req, alreadySettled, source: 'stripe_return' })
  res.json({ status: payment.status, payment })
}

/* Copy Stripe's identifiers onto a Payment (shared with the webhook handler). */
export function applyStripeSessionRefs(payment, session) {
  payment.gateway = 'stripe'
  payment.paymentMethod = 'STRIPE'
  payment.stripeSessionId = session.id
  const pi = session.payment_intent
  if (pi) {
    payment.stripePaymentIntentId = typeof pi === 'string' ? pi : pi.id
    payment.gatewayTransactionId = payment.stripePaymentIntentId
  }
  const sub = session.subscription
  if (sub) payment.stripeSubscriptionId = typeof sub === 'string' ? sub : sub.id
  if (session.invoice) {
    payment.stripeInvoiceId = typeof session.invoice === 'string' ? session.invoice : session.invoice.id
  }
}

/* Record the newly-created subscription on the link. */
export async function applySubscriptionToLink(link, session) {
  const sub = session.subscription
  link.stripeSubscriptionId = typeof sub === 'string' ? sub : sub?.id || ''
  link.stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || ''
  if (sub && typeof sub !== 'string') {
    link.subscriptionStatus = sub.status || 'active'
    const periodEnd = periodEndOf(sub)
    if (periodEnd) link.subscriptionCurrentPeriodEnd = periodEnd
    link.subscriptionCancelAtPeriodEnd = Boolean(sub.cancel_at_period_end)
  } else if (!link.subscriptionStatus) {
    link.subscriptionStatus = 'active'
  }
  await link.save()
}
