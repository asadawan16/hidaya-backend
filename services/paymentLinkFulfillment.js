import PaymentLink from '../models/PaymentLink.js'
import Payment from '../models/Payment.js'
import DiscountCode from '../models/DiscountCode.js'
import {
  notifyAdmin, sendToUser,
  paymentEmail, paymentConfirmationEmail, invoiceEmail,
} from './mailer.js'
import { logActivity } from '../utils/activityLogger.js'

/*
 * Everything that happens around a payment-link charge, shared by the three
 * entry points that can settle one:
 *   - paymentLinkController.callback()   (Mastercard return URL)
 *   - paymentLinkController.callback()   (Stripe return URL re-sync)
 *   - stripeWebhookController            (the authoritative Stripe signal)
 *
 * Keeping it in one place is what makes the browser return and the webhook
 * safely racy: whichever lands first settles the payment, the other is a no-op.
 */

/* ── Tax added on top of a (post-discount) subtotal ── */
export function computeTax(subtotal, taxType, taxValue) {
  const val = Number(taxValue) || 0
  if (taxType === 'percentage') return Math.round(subtotal * (val / 100) * 100) / 100
  if (taxType === 'fixed') return Math.max(0, val)
  return 0
}

/* ── Unique invoice number: HO-YYYYMM-XXXX ── */
export async function generateInvoiceNo() {
  const now = new Date()
  const prefix = `HO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  const latest = await PaymentLink.findOne(
    { invoiceNo: new RegExp(`^${prefix}-`) },
    { invoiceNo: 1 },
    { sort: { invoiceNo: -1 } }
  )
  let seq = 1
  if (latest?.invoiceNo) {
    const parts = latest.invoiceNo.split('-')
    const lastSeq = parseInt(parts[parts.length - 1], 10)
    if (!isNaN(lastSeq)) seq = lastSeq + 1
  }
  return `${prefix}-${String(seq).padStart(4, '0')}`
}

/* ── Validate a discount code and price the charge ──
 * Returns { subtotal, taxAmount, finalAmount, appliedDiscount } or, when the
 * code is unusable, { error } for the caller to turn into a 400. */
export async function priceLinkCharge(link, discountCodeInput = '') {
  const code = String(discountCodeInput || '').trim().toUpperCase()
  const currency = link.currency || 'PKR'
  let appliedDiscount = null
  let subtotal = link.amount

  if (code) {
    const dc = await DiscountCode.findOne({ code })
    if (!dc || !dc.isActive) return { error: 'Invalid or inactive discount code' }
    if (dc.currency !== currency) return { error: `Discount code is for ${dc.currency} payments only` }
    if (dc.usageType === 'one_time' && dc.timesUsed >= 1) return { error: 'This discount code has already been used' }
    if (dc.discountAmount >= link.amount) return { error: 'Discount cannot exceed the payment amount' }
    appliedDiscount = dc
    subtotal = link.amount - dc.discountAmount
  }

  const taxAmount = computeTax(subtotal, link.taxType, link.taxValue)
  return { subtotal, taxAmount, finalAmount: subtotal + taxAmount, appliedDiscount }
}

/* ── Build the Payment document body for a link charge ── */
export function buildPaymentData(link, { orderId, finalAmount, taxAmount, appliedDiscount, gateway, paymentMethod }) {
  const data = {
    studentName: link.payeeName,
    studentEmail: link.payeeEmail,
    studentPhone: link.payeePhone,
    plan: link.description,
    amount: finalAmount,
    currency: link.currency || 'PKR',
    gatewayOrderId: orderId,
    gateway: gateway || 'mastercard',
    paymentLink: link._id,
    invoiceNo: link.invoiceNo,
    status: 'pending',
  }
  if (paymentMethod) data.paymentMethod = paymentMethod
  if (link.student) data.student = link.student
  if (appliedDiscount) {
    data.discountCode = appliedDiscount.code
    data.discountCodeRef = appliedDiscount._id
    data.discountAmount = appliedDiscount.discountAmount
    data.originalAmount = link.amount
  }
  if (taxAmount > 0) {
    data.taxAmount = taxAmount
    data.taxType = link.taxType
    data.taxValue = link.taxValue
    if (!appliedDiscount) data.originalAmount = link.amount
  }
  return data
}

/* ── Settle a payment against its link ──
 * Idempotent by design: call it as often as you like for the same payment —
 * the discount counter, the link's payments array and the emails each fire at
 * most once, tracked by the payment's own already-settled state.
 *
 * `payment.status` must already be set to its final value by the caller. */
export async function settleLinkPayment({ link, payment, req, alreadySettled = false, source = '' }) {
  await payment.save()

  if (!link.payments) link.payments = []
  const already = link.payments.some(id => String(id) === String(payment._id))
  if (!already) link.payments.push(payment._id)

  if (payment.status === 'completed') {
    if (link.expiresAfterPayment && link.paymentMode !== 'recurring') {
      // Single-use link — no further payments accepted.
      link.status = 'completed'
    } else if (!alreadySettled && link.status !== 'completed') {
      // Reusable/recurring link — roll a fresh invoice number for the next
      // cycle. Guarded on `alreadySettled` so a webhook + return-URL double
      // settle doesn't burn two numbers for one charge.
      link.invoiceNo = await generateInvoiceNo()
    }
  }
  // A failed one-off leaves the link 'active' so the payer can simply retry.

  await link.save()

  // Everything below is a one-shot side effect — skip it on a re-entry.
  if (alreadySettled) return payment

  if (payment.status === 'completed' && payment.discountCodeRef) {
    await DiscountCode.findByIdAndUpdate(payment.discountCodeRef, { $inc: { timesUsed: 1 } })
  }

  const paymentData = payment.toObject()

  logActivity({
    level: payment.status === 'completed' ? 'info' : 'warning',
    category: 'payment_link',
    action: `payment_${payment.status}`,
    message: `Payment ${payment.status} — ${payment.currency} ${payment.amount} from ${payment.studentName || 'unknown'} (${payment.invoiceNo || link.invoiceNo})`,
    ...(req ? { req } : {}),
    meta: {
      orderId: payment.gatewayOrderId,
      paymentId: payment._id,
      linkId: link._id,
      amount: payment.amount,
      currency: payment.currency,
      gateway: payment.gateway,
      billingReason: payment.billingReason || null,
      discountCode: payment.discountCode || null,
      gatewayResult: payment.gatewayResult,
      source: source || undefined,
    },
  })

  notifyAdmin(paymentEmail(paymentData)).catch(() => {})

  if (paymentData.studentEmail) {
    if (payment.status === 'completed') {
      const invoice = invoiceEmail({ link: link.toObject(), payment: paymentData })
      sendToUser({ to: paymentData.studentEmail, ...invoice }).catch(() => {})
    } else {
      const userEmail = paymentConfirmationEmail(paymentData)
      sendToUser({ to: paymentData.studentEmail, ...userEmail }).catch(() => {})
    }
  }

  return payment
}

/* ── Expire the link's outstanding pending payment before starting a new one ── */
export async function expirePendingPayment(link) {
  if (!link.payment) return
  await Payment.updateOne({ _id: link.payment, status: 'pending' }, { status: 'expired' })
}
