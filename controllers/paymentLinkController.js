import PaymentLink from '../models/PaymentLink.js'
import Payment from '../models/Payment.js'
import DiscountCode from '../models/DiscountCode.js'
import { createCheckoutSession, initiateBrowserPayment, retrieveOrder } from '../services/mastercard.js'
import {
  notifyAdmin, sendToUser,
  paymentLinkEmail, paymentLinkAdminEmail,
  paymentEmail, paymentConfirmationEmail, invoiceEmail,
} from '../services/mailer.js'
import { logActivity } from '../utils/activityLogger.js'

/* ── Generate unique invoice number: HO-YYYYMM-XXXX ── */
async function generateInvoiceNo() {
  const now = new Date()
  const prefix = `HO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  // Find the highest invoice number for this month
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

/* ── Admin: Create a payment link ── */
export async function create(req, res) {
  try {
    const { payeeName, payeeEmail, payeePhone, description, amount, currency, notes, expiresAfterPayment, items, listType, student } = req.body
    if (!payeeName || !description || !amount) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const validCurrencies = ['PKR', 'USD', 'EUR', 'GBP']
    const invoiceNo = await generateInvoiceNo()

    const linkData = {
      payeeName,
      payeeEmail,
      payeePhone,
      description,
      amount: Number(amount),
      currency: validCurrencies.includes(currency) ? currency : 'PKR',
      notes,
      expiresAfterPayment: expiresAfterPayment !== false,
      items: Array.isArray(items) ? items.filter(i => i.trim()) : [],
      listType: listType === 'numbered' ? 'numbered' : 'bullet',
      invoiceNo,
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
      status: link.status,
      token: link.token,
      expiresAfterPayment: link.expiresAfterPayment,
      items: link.items || [],
      listType: link.listType || 'bullet',
      invoiceNo: link.invoiceNo,
    })
  } catch (err) {
    console.error('PaymentLink getByToken error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Public: Initiate payment from link ── */
export async function initiate(req, res) {
  try {
    const link = await PaymentLink.findOne({ token: req.params.token })
    if (!link) return res.status(404).json({ error: 'Payment link not found' })
    if (link.status === 'completed') {
      return res.status(400).json({ error: 'This payment link has already been used' })
    }

    // Expire any previous pending payment for this link
    if (link.payment) {
      await Payment.updateOne(
        { _id: link.payment, status: 'pending' },
        { status: 'expired' }
      )
    }

    // Validate and apply discount code if provided
    const discountCodeStr = req.body.discountCode?.trim()?.toUpperCase() || ''
    let appliedDiscount = null
    let finalAmount = link.amount

    if (discountCodeStr) {
      const dc = await DiscountCode.findOne({ code: discountCodeStr })
      if (!dc || !dc.isActive) {
        return res.status(400).json({ error: 'Invalid or inactive discount code' })
      }
      if (dc.currency !== (link.currency || 'PKR')) {
        return res.status(400).json({ error: `Discount code is for ${dc.currency} payments only` })
      }
      if (dc.usageType === 'one_time' && dc.timesUsed >= 1) {
        return res.status(400).json({ error: 'This discount code has already been used' })
      }
      if (dc.discountAmount >= link.amount) {
        return res.status(400).json({ error: 'Discount cannot exceed the payment amount' })
      }
      appliedDiscount = dc
      finalAmount = link.amount - dc.discountAmount
    }

    const orderId = `PL-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const paymentData = {
      studentName: link.payeeName,
      studentEmail: link.payeeEmail,
      studentPhone: link.payeePhone,
      plan: link.description,
      amount: finalAmount,
      currency: link.currency || 'PKR',
      gatewayOrderId: orderId,
      paymentLink: link._id,
      invoiceNo: link.invoiceNo,
      status: 'pending',
    }
    if (link.student) paymentData.student = link.student
    if (appliedDiscount) {
      paymentData.discountCode = appliedDiscount.code
      paymentData.discountCodeRef = appliedDiscount._id
      paymentData.discountAmount = appliedDiscount.discountAmount
      paymentData.originalAmount = link.amount
    }

    const payment = await Payment.create(paymentData)

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

    // Expire any previous pending payment for this link
    if (link.payment) {
      await Payment.updateOne(
        { _id: link.payment, status: 'pending' },
        { status: 'expired' }
      )
    }

    // Validate and apply discount code if provided
    const discountCodeStr = req.body.discountCode?.trim()?.toUpperCase() || ''
    let appliedDiscount = null
    let finalAmount = link.amount

    if (discountCodeStr) {
      const dc = await DiscountCode.findOne({ code: discountCodeStr })
      if (!dc || !dc.isActive) {
        return res.status(400).json({ error: 'Invalid or inactive discount code' })
      }
      if (dc.currency !== currency) {
        return res.status(400).json({ error: `Discount code is for ${dc.currency} payments only` })
      }
      if (dc.usageType === 'one_time' && dc.timesUsed >= 1) {
        return res.status(400).json({ error: 'This discount code has already been used' })
      }
      if (dc.discountAmount >= link.amount) {
        return res.status(400).json({ error: 'Discount cannot exceed the payment amount' })
      }
      appliedDiscount = dc
      finalAmount = link.amount - dc.discountAmount
    }

    const orderId = `PL-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const paymentData = {
      studentName: link.payeeName,
      studentEmail: link.payeeEmail,
      studentPhone: link.payeePhone,
      plan: link.description,
      amount: finalAmount,
      currency,
      gatewayOrderId: orderId,
      paymentLink: link._id,
      invoiceNo: link.invoiceNo,
      status: 'pending',
      paymentMethod: 'PAYPAL',
    }
    if (link.student) paymentData.student = link.student
    if (appliedDiscount) {
      paymentData.discountCode = appliedDiscount.code
      paymentData.discountCodeRef = appliedDiscount._id
      paymentData.discountAmount = appliedDiscount.discountAmount
      paymentData.originalAmount = link.amount
    }

    const payment = await Payment.create(paymentData)
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

/* ── Public: Payment callback for link ── */
export async function callback(req, res) {
  try {
    const { orderId } = req.body
    const { token } = req.params
    if (!orderId) return res.status(400).json({ error: 'Order ID required' })

    const link = await PaymentLink.findOne({ token })
    if (!link) return res.status(404).json({ error: 'Payment link not found' })

    const payment = await Payment.findOne({ gatewayOrderId: orderId })
    if (!payment) return res.status(404).json({ error: 'Payment not found' })

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

    await payment.save()

    // Add payment to the link's payments array
    if (!link.payments) link.payments = []
    if (!link.payments.includes(payment._id)) {
      link.payments.push(payment._id)
    }

    if (payment.status === 'completed' && link.expiresAfterPayment) {
      // Single-use link — mark as completed
      link.status = 'completed'
    } else if (payment.status === 'completed' && !link.expiresAfterPayment) {
      // Recurring link — generate new invoice number for next payment
      link.invoiceNo = await generateInvoiceNo()
    }

    await link.save()

    // Increment discount code usage count if this payment used one
    if (payment.status === 'completed' && payment.discountCodeRef) {
      await DiscountCode.findByIdAndUpdate(payment.discountCodeRef, { $inc: { timesUsed: 1 } })
    }

    const paymentData = payment.toObject()

    // Log payment outcome
    logActivity({
      level: payment.status === 'completed' ? 'info' : 'warning',
      category: 'payment_link',
      action: `payment_${payment.status}`,
      message: `Payment ${payment.status} — ${payment.currency} ${payment.amount} from ${payment.studentName || 'unknown'} (${link.invoiceNo})`,
      req,
      meta: {
        orderId,
        paymentId: payment._id,
        linkId: link._id,
        amount: payment.amount,
        currency: payment.currency,
        discountCode: payment.discountCode || null,
        gatewayResult: payment.gatewayResult,
      },
    })

    // Notify admin
    notifyAdmin(paymentEmail(paymentData)).catch(() => {})

    if (payment.status === 'completed') {
      const invoice = invoiceEmail({ link: link.toObject(), payment: paymentData })
      sendToUser({ to: paymentData.studentEmail, ...invoice }).catch(() => {})
    } else {
      const userEmail = paymentConfirmationEmail(paymentData)
      sendToUser({ to: paymentData.studentEmail, ...userEmail }).catch(() => {})
    }

    res.json({ status: payment.status, payment })
  } catch (err) {
    console.error('PaymentLink callback error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
