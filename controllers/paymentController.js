import Payment from '../models/Payment.js'
import { createCheckoutSession, retrieveOrder } from '../services/mastercard.js'
import { notifyAdmin, sendToUser, paymentEmail, paymentConfirmationEmail } from '../services/mailer.js'

export async function initiate(req, res) {
  try {
    const { studentName, studentEmail, studentPhone, plan, amount, currency } = req.body
    if (!studentName || !studentEmail || !plan || !amount) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const validCurrencies = ['PKR', 'USD', 'EUR', 'GBP']
    const cur = validCurrencies.includes(currency) ? currency : 'PKR'
    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const payment = await Payment.create({
      studentName,
      studentEmail,
      studentPhone,
      plan,
      amount: Number(amount),
      currency: cur,
      gatewayOrderId: orderId,
      status: 'pending',
    })

    const sessionData = await createCheckoutSession({
      orderId,
      amount,
      currency: cur,
      plan,
      returnUrl: `${process.env.FRONTEND_URL}/payment/callback?orderId=${orderId}`,
      cancelUrl: `${process.env.FRONTEND_URL}/fee`,
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

export async function callback(req, res) {
  try {
    const { orderId } = req.body
    if (!orderId) return res.status(400).json({ error: 'Order ID required' })

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

    const paymentData = payment.toObject()

    // Notify admin (non-blocking)
    notifyAdmin(paymentEmail(paymentData)).catch(() => {})

    // Send confirmation to student (non-blocking)
    const userEmail = paymentConfirmationEmail(paymentData)
    sendToUser({ to: paymentData.studentEmail, ...userEmail }).catch(() => {})

    res.json({ status: payment.status, payment })
  } catch (err) {
    console.error('Payment callback error:', err)
    res.status(500).json({ error: 'Server error' })
  }
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
