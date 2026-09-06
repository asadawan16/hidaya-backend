import Payment from '../models/Payment.js'
import DiscountCode from '../models/DiscountCode.js'
import { createCheckoutSession, initiateBrowserPayment, retrieveOrder } from '../services/mastercard.js'
import {
  isStripeEnabled,
  createCheckoutSession as createStripeCheckoutSession,
  retrieveCheckoutSession,
} from '../services/stripe.js'
import { applyStripeSessionRefs } from './paymentLinkController.js'
import { notifyAdmin, sendToUser, paymentEmail, paymentConfirmationEmail } from '../services/mailer.js'
import { logActivity } from '../utils/activityLogger.js'

const VALID_CURRENCIES = ['PKR', 'USD', 'EUR', 'GBP', 'CAD']

const newOrderId = () => `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

/* ── Validate the fee-page body and price the charge ──
 * The fee page posts the same shape whichever processor it is pointed at, so
 * all three initiate paths (Mastercard, PayPal, Stripe) read it identically.
 * Returns `{ error }` for the caller to turn into a 400. */
async function pricePlanCharge(body) {
  const {
    studentName, studentEmail, studentPhone, plan, amount, currency,
    discountCode: discountCodeStr, quantity: rawQty, studentNames: rawStudentNames,
  } = body

  if (!studentName || !studentEmail || !plan || !amount) {
    return { error: 'Missing required fields' }
  }

  const cur = VALID_CURRENCIES.includes(currency) ? currency : 'PKR'

  // Multi-student: quantity defaults to 1, studentNames is optional array
  const quantity = Math.max(1, Math.floor(Number(rawQty) || 1))
  const studentNames = Array.isArray(rawStudentNames)
    ? rawStudentNames.map(n => (n || '').trim()).filter(Boolean)
    : []

  // Total amount = unit price × quantity
  const totalAmount = Number(amount) * quantity
  if (!(totalAmount > 0)) return { error: 'Invalid amount' }

  // Validate and apply discount code if provided
  let appliedDiscount = null
  let finalAmount = totalAmount
  const codeStr = discountCodeStr?.trim()?.toUpperCase() || ''

  if (codeStr) {
    const dc = await DiscountCode.findOne({ code: codeStr })
    if (!dc || !dc.isActive) return { error: 'Invalid or inactive discount code' }
    if (dc.currency !== cur) return { error: `Discount code is for ${dc.currency} payments only` }
    if (dc.usageType === 'one_time' && dc.timesUsed >= 1) return { error: 'This discount code has already been used' }
    if (dc.discountAmount >= totalAmount) return { error: 'Discount cannot exceed the payment amount' }
    appliedDiscount = dc
    finalAmount = totalAmount - dc.discountAmount
  }

  return { studentName, studentEmail, studentPhone, plan, cur, quantity, studentNames, totalAmount, finalAmount, appliedDiscount }
}

/* ── The Payment document body for a fee-page charge ── */
function buildPlanPaymentData(priced, { orderId, gateway, paymentMethod }) {
  const data = {
    studentName: priced.studentName,
    studentEmail: priced.studentEmail,
    studentPhone: priced.studentPhone,
    plan: priced.plan,
    amount: priced.finalAmount,
    currency: priced.cur,
    gatewayOrderId: orderId,
    status: 'pending',
    quantity: priced.quantity,
    studentNames: priced.studentNames,
  }
  if (gateway) data.gateway = gateway
  if (paymentMethod) data.paymentMethod = paymentMethod
  if (priced.appliedDiscount) {
    data.discountCode = priced.appliedDiscount.code
    data.discountCodeRef = priced.appliedDiscount._id
    data.discountAmount = priced.appliedDiscount.discountAmount
    data.originalAmount = priced.totalAmount
  }
  return data
}

/* The label shown on the gateway's own checkout page. */
const planLabel = priced => (priced.quantity > 1 ? `${priced.plan} (×${priced.quantity} students)` : priced.plan)

export async function initiate(req, res) {
  try {
    const priced = await pricePlanCharge(req.body)
    if (priced.error) return res.status(400).json({ error: priced.error })

    const { cur, finalAmount, studentName, studentEmail } = priced
    const orderId = newOrderId()

    const payment = await Payment.create(buildPlanPaymentData(priced, { orderId, gateway: 'mastercard' }))

    const sessionData = await createCheckoutSession({
      orderId,
      amount: finalAmount,
      currency: cur,
      plan: planLabel(priced),
      returnUrl: `${process.env.FRONTEND_URL}/payment/callback?orderId=${orderId}`,
      cancelUrl: `${process.env.FRONTEND_URL}/fee`,
      customerName: studentName,
      customerEmail: studentEmail || undefined,
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
    console.error('Payment initiate error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function initiatePayPal(req, res) {
  try {
    const priced = await pricePlanCharge(req.body)
    if (priced.error) return res.status(400).json({ error: priced.error })

    const { cur, finalAmount } = priced
    if (cur === 'PKR') {
      return res.status(400).json({ error: 'PayPal is not available for PKR payments' })
    }

    const orderId = newOrderId()
    const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const payment = await Payment.create(buildPlanPaymentData(priced, {
      orderId, gateway: 'mastercard', paymentMethod: 'PAYPAL',
    }))

    const result = await initiateBrowserPayment({
      orderId,
      transactionId,
      amount: finalAmount,
      currency: cur,
      plan: planLabel(priced),
      returnUrl: `${process.env.FRONTEND_URL}/payment/callback?orderId=${orderId}`,
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
    console.error('Payment initiatePayPal error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Public: start a Stripe hosted Checkout for a fee-page plan ──
 * No card data touches this server: the browser is redirected to Stripe and
 * the authoritative result arrives on POST /api/stripe/webhook. The return URL
 * (handled below) is only a convenience re-sync so the payer sees a receipt
 * without waiting for the hook. */
export async function initiateStripe(req, res) {
  try {
    if (!isStripeEnabled()) {
      return res.status(503).json({ error: 'Stripe payments are not configured' })
    }

    const priced = await pricePlanCharge(req.body)
    if (priced.error) return res.status(400).json({ error: priced.error })

    const orderId = newOrderId()
    const payment = await Payment.create(buildPlanPaymentData(priced, {
      orderId, gateway: 'stripe', paymentMethod: 'STRIPE',
    }))

    const session = await createStripeCheckoutSession({
      amount: priced.finalAmount,
      currency: priced.cur,
      description: planLabel(priced),
      items: priced.studentNames,
      successUrl: `${process.env.FRONTEND_URL}/payment/callback?provider=stripe&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${process.env.FRONTEND_URL}/fee`,
      customerName: priced.studentName,
      customerEmail: priced.studentEmail || undefined,
      // `kind: 'plan'` is what tells the webhook this session belongs to a
      // fee-page purchase rather than a payment link.
      metadata: { kind: 'plan', paymentId: String(payment._id), orderId },
    })

    payment.stripeSessionId = session.id
    await payment.save()

    res.json({
      url: session.url,
      sessionId: session.id,
      orderId,
      paymentId: payment._id,
    })
  } catch (err) {
    console.error('Payment initiateStripe error:', err)
    res.status(500).json({ error: err?.message || 'Failed to start Stripe checkout' })
  }
}

/* ── Everything that happens once a fee-page payment reaches a final state ──
 * Shared by the Mastercard return, the Stripe return and the Stripe webhook,
 * any of which can land first. Idempotent: pass `alreadySettled: true` on a
 * re-entry and the one-shot side effects (discount counter, emails) are
 * skipped. `payment.status` must already carry its final value.
 *
 * Exported because stripeWebhookController settles plan payments through it. */
export async function finalizePlanPayment({ payment, alreadySettled = false, req, source = '' }) {
  await payment.save()
  if (alreadySettled) return payment

  // Increment discount code usage if applicable
  if (payment.status === 'completed' && payment.discountCodeRef) {
    await DiscountCode.findByIdAndUpdate(payment.discountCodeRef, { $inc: { timesUsed: 1 } })
  }

  const paymentData = payment.toObject()

  logActivity({
    level: payment.status === 'completed' ? 'info' : 'warning',
    category: 'payment',
    action: `payment_${payment.status}`,
    message: `Payment ${payment.status} — ${payment.currency} ${payment.amount} from ${payment.studentName || 'unknown'} (${payment.plan})`,
    ...(req ? { req } : {}),
    meta: {
      orderId: payment.gatewayOrderId,
      paymentId: payment._id,
      gateway: payment.gateway,
      gatewayResult: payment.gatewayResult,
      discountCode: payment.discountCode || null,
      source: source || undefined,
    },
  })

  // Notify admin (non-blocking)
  notifyAdmin(paymentEmail(paymentData)).catch(() => {})

  // Send confirmation to student (non-blocking)
  if (paymentData.studentEmail) {
    const userEmail = paymentConfirmationEmail(paymentData)
    sendToUser({ to: paymentData.studentEmail, ...userEmail }).catch(() => {})
  }

  return payment
}

/* ── Settle a fee-page payment from a Stripe Checkout session ──
 * Shared by the return URL and the webhook. `session` must be the retrieved
 * (expanded) session, not the thin webhook copy. Returns null when the session
 * has no fee-page payment behind it. */
export async function settlePlanPaymentFromSession(session, { req, source = '' } = {}) {
  const payment = await findSessionPlanPayment(session)
  if (!payment) return null
  // A session that belongs to a payment link is settled by the link path.
  if (payment.paymentLink) return null

  const alreadySettled = payment.status === 'completed'

  // `paid` covers a normal charge; `no_payment_required` is a fully-discounted
  // session that still completed successfully.
  const ok = session.payment_status === 'paid' || session.payment_status === 'no_payment_required'

  if (ok) {
    payment.status = 'completed'
    payment.gatewayResult = 'SUCCESS'
    applyStripeSessionRefs(payment, session)
  } else if (session.status === 'expired') {
    // An abandoned checkout — worth recording, not worth emailing anyone about.
    if (alreadySettled) return payment
    payment.status = 'expired'
    payment.gatewayResult = 'SESSION_EXPIRED'
    await payment.save()
    return payment
  } else {
    // Still open / processing — leave it pending and let the webhook decide.
    await payment.save()
    return payment
  }

  return finalizePlanPayment({ payment, alreadySettled, req, source })
}

async function findSessionPlanPayment(session) {
  if (session.metadata?.paymentId) {
    const byId = await Payment.findById(session.metadata.paymentId).catch(() => null)
    if (byId) return byId
  }
  return Payment.findOne({ stripeSessionId: session.id })
}

/* ── Public: payment return URL ──
 * Mastercard/PayPal post `{ orderId }`; Stripe's return URL posts
 * `{ sessionId }`. Both funnel through finalizePlanPayment(). */
export async function callback(req, res) {
  try {
    const { orderId, sessionId } = req.body

    if (sessionId) return stripePlanCallback(req, res, sessionId)

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

    await finalizePlanPayment({ payment, alreadySettled, req, source: 'mastercard_callback' })

    res.json({ status: payment.status, payment })
  } catch (err) {
    console.error('Payment callback error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* Stripe return-URL re-sync — reads the session straight from Stripe rather
 * than trusting the query string. */
async function stripePlanCallback(req, res, sessionId) {
  if (!isStripeEnabled()) return res.status(503).json({ error: 'Stripe payments are not configured' })

  const session = await retrieveCheckoutSession(sessionId).catch(() => null)
  if (!session) return res.status(404).json({ error: 'Checkout session not found' })

  const payment = await settlePlanPaymentFromSession(session, { req, source: 'stripe_return' })
  if (!payment) return res.status(404).json({ error: 'Payment not found' })

  res.json({ status: payment.status, payment })
}

export async function list(req, res) {
  try {
    const { status, source, search, page = 1, limit = 20, startDate, endDate } = req.query
    const filter = {}
    if (status) filter.status = status
    if (source === 'plan') filter.paymentLink = { $exists: false }
    else if (source === 'link') filter.paymentLink = { $exists: true }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ studentName: regex }, { studentEmail: regex }, { plan: regex }]
    }
    if (startDate || endDate) {
      filter.createdAt = {}
      if (startDate) filter.createdAt.$gte = new Date(startDate)
      if (endDate) filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999))
    }

    const total = await Payment.countDocuments(filter)
    const payments = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))

    res.json({ payments, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    console.error('Payment list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getStats(req, res) {
  try {
    const { startDate, endDate } = req.query
    const dateFilter = {}
    if (startDate || endDate) {
      dateFilter.createdAt = {}
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate)
      if (endDate) dateFilter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999))
    }

    const [total, completed, pending, failed, expired] = await Promise.all([
      Payment.countDocuments(dateFilter),
      Payment.countDocuments({ status: 'completed', ...dateFilter }),
      Payment.countDocuments({ status: 'pending', ...dateFilter }),
      Payment.countDocuments({ status: 'failed', ...dateFilter }),
      Payment.countDocuments({ status: 'expired', ...dateFilter }),
    ])

    const revenueResult = await Payment.aggregate([
      { $match: { status: 'completed', ...dateFilter } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ])
    const totalRevenue = revenueResult[0]?.total || 0

    // Revenue grouped by currency
    const revenueByCurrency = await Payment.aggregate([
      { $match: { status: 'completed', ...dateFilter } },
      { $group: { _id: { $ifNull: ['$currency', 'PKR'] }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])

    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    const monthlyDateFilter = dateFilter.createdAt ? dateFilter : { createdAt: { $gte: sixMonthsAgo } }

    const monthly = await Payment.aggregate([
      { $match: { status: 'completed', ...monthlyDateFilter } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          revenue: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])

    // Monthly revenue grouped by currency
    const monthlyByCurrency = await Payment.aggregate([
      { $match: { status: 'completed', ...monthlyDateFilter } },
      {
        $group: {
          _id: {
            month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
            currency: { $ifNull: ['$currency', 'PKR'] },
          },
          revenue: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.month': 1 } },
    ])

    const recent = await Payment.find(dateFilter).sort({ createdAt: -1 }).limit(5)

    // Total students count
    const Student = (await import('../models/Student.js')).default
    const totalStudents = await Student.countDocuments()

    // Weekly revenue (current week Mon–Sun) — NOT affected by date filters
    const now = new Date()
    const dayOfWeek = now.getDay() // 0=Sun, 1=Mon, ...
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset)
    const sunday = new Date(monday)
    sunday.setDate(sunday.getDate() + 6)
    sunday.setHours(23, 59, 59, 999)

    const weeklyRevenue = await Payment.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: monday, $lte: sunday } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            currency: { $ifNull: ['$currency', 'PKR'] },
          },
          revenue: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 } },
    ])

    // Build the week range string for frontend label
    const weekRange = `${monday.toISOString().slice(0, 10)} to ${sunday.toISOString().slice(0, 10)}`

    res.json({ total, completed, pending, failed, expired, totalRevenue, revenueByCurrency, monthly, monthlyByCurrency, recent, totalStudents, weeklyRevenue, weekRange })
  } catch (err) {
    console.error('Payment stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function update(req, res) {
  try {
    const { status, notes } = req.body
    const updateData = {}
    if (status) updateData.status = status
    if (notes !== undefined) updateData.notes = notes

    const payment = await Payment.findByIdAndUpdate(req.params.id, updateData, { new: true })
    if (!payment) return res.status(404).json({ error: 'Payment not found' })
    res.json(payment)
  } catch (err) {
    console.error('Payment update error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
