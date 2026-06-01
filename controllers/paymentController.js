import Payment from '../models/Payment.js'
import { createCheckoutSession, retrieveOrder } from '../services/mastercard.js'
import { notifyAdmin, paymentEmail } from '../services/mailer.js'

export async function initiate(req, res) {
  try {
    const { studentName, studentEmail, studentPhone, plan, amount } = req.body
    if (!studentName || !studentEmail || !plan || !amount) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const payment = await Payment.create({
      studentName,
      studentEmail,
      studentPhone,
      plan,
      amount: Number(amount),
      gatewayOrderId: orderId,
      status: 'pending',
    })

    const sessionData = await createCheckoutSession({
      orderId,
      amount,
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

    // Notify admin (non-blocking)
    notifyAdmin(paymentEmail(payment.toObject())).catch(() => {})

    res.json({ status: payment.status, payment })
  } catch (err) {
    console.error('Payment callback error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function list(req, res) {
  try {
    const { status, page = 1, limit = 20 } = req.query
    const filter = {}
    if (status) filter.status = status

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
    const [total, completed, pending, failed] = await Promise.all([
      Payment.countDocuments(),
      Payment.countDocuments({ status: 'completed' }),
      Payment.countDocuments({ status: 'pending' }),
      Payment.countDocuments({ status: 'failed' }),
    ])

    const revenueResult = await Payment.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ])
    const totalRevenue = revenueResult[0]?.total || 0

    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

    const monthly = await Payment.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          revenue: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])

    const recent = await Payment.find().sort({ createdAt: -1 }).limit(5)

    res.json({ total, completed, pending, failed, totalRevenue, monthly, recent })
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
