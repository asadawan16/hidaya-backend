import PaymentLink from '../models/PaymentLink.js'
import Payment from '../models/Payment.js'
import { createCheckoutSession, retrieveOrder } from '../services/mastercard.js'
import {
  notifyAdmin, sendToUser,
  paymentLinkEmail, paymentLinkAdminEmail,
  paymentEmail, paymentConfirmationEmail, invoiceEmail,
} from '../services/mailer.js'

/* ── Admin: Create a payment link ── */
export async function create(req, res) {
  try {
    const { payeeName, payeeEmail, payeePhone, description, amount, currency, notes, expiresAfterPayment, items, listType, student } = req.body
    if (!payeeName || !payeeEmail || !description || !amount) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const validCurrencies = ['PKR', 'USD', 'EUR', 'GBP']
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
      ]
      // Also match amount if the search is numeric
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
      .populate('student', 'name email')

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

    // Return limited info for public
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

    const orderId = `PL-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const paymentData = {
      studentName: link.payeeName,
      studentEmail: link.payeeEmail,
      studentPhone: link.payeePhone,
      plan: link.description,
      amount: link.amount,
      currency: link.currency || 'PKR',
      gatewayOrderId: orderId,
      paymentLink: link._id,
      status: 'pending',
    }
    if (link.student) paymentData.student = link.student

    const payment = await Payment.create(paymentData)

    // Link the payment to the payment link
    link.payment = payment._id
    await link.save()

    const sessionData = await createCheckoutSession({
      orderId,
      amount: link.amount,
      currency: link.currency || 'PKR',
      plan: link.description,
      returnUrl: `${process.env.FRONTEND_URL}/pay/${link.token}/callback?orderId=${orderId}`,
      cancelUrl: `${process.env.FRONTEND_URL}/pay/${link.token}`,
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

    // Only mark link as completed if expiresAfterPayment is enabled
    if (payment.status === 'completed' && link.expiresAfterPayment) {
      link.status = 'completed'
      await link.save()
    }
    // On failure, link stays active so user can retry
    // If expiresAfterPayment is false, link stays active for reuse

    const paymentData = payment.toObject()

    // Notify admin
    notifyAdmin(paymentEmail(paymentData)).catch(() => {})

    if (payment.status === 'completed') {
      // Send invoice to payee
      const invoice = invoiceEmail({ link: link.toObject(), payment: paymentData })
      sendToUser({ to: paymentData.studentEmail, ...invoice }).catch(() => {})
    } else {
      // Send failure notification to payee
      const userEmail = paymentConfirmationEmail(paymentData)
      sendToUser({ to: paymentData.studentEmail, ...userEmail }).catch(() => {})
    }

    res.json({ status: payment.status, payment })
  } catch (err) {
    console.error('PaymentLink callback error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
