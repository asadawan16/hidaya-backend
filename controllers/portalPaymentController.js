import Payment from '../models/Payment.js'
import PaymentLink from '../models/PaymentLink.js'
import DiscountCode from '../models/DiscountCode.js'
import Plan from '../models/Plan.js'
import Student from '../models/Student.js'
import Family from '../models/Family.js'
import { logActivity } from '../utils/activityLogger.js'

// ──────────────────────────────────────────────
// PAYMENTS
// ──────────────────────────────────────────────

export async function listPayments(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20))
    const { status, source, search, startDate, endDate } = req.query

    const filter = {}

    if (status) filter.status = status

    if (source === 'plan') filter.paymentLink = { $exists: false }
    else if (source === 'link') filter.paymentLink = { $exists: true }

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [
        { studentName: regex },
        { studentEmail: regex },
        { invoiceNo: regex },
        { gatewayOrderId: regex },
      ]
    }

    if (startDate || endDate) {
      filter.createdAt = {}
      if (startDate) filter.createdAt.$gte = new Date(startDate)
      if (endDate) filter.createdAt.$lte = new Date(endDate)
    }

    const total = await Payment.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await Payment.find(filter)
      .populate('paymentLink', 'payeeName description')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('listPayments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getPaymentStats(req, res) {
  try {
    const { startDate, endDate } = req.query
    const dateFilter = {}
    if (startDate || endDate) {
      dateFilter.createdAt = {}
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate)
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate)
    }

    // Status counts
    const [total, completed, pending, failed, expired] = await Promise.all([
      Payment.countDocuments(dateFilter),
      Payment.countDocuments({ ...dateFilter, status: 'completed' }),
      Payment.countDocuments({ ...dateFilter, status: 'pending' }),
      Payment.countDocuments({ ...dateFilter, status: 'failed' }),
      Payment.countDocuments({ ...dateFilter, status: 'expired' }),
    ])

    // Revenue by currency
    const revenueByCurrency = await Payment.aggregate([
      { $match: { ...dateFilter, status: 'completed' } },
      { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])

    // Monthly revenue trend (last 6 months)
    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    sixMonthsAgo.setDate(1)
    sixMonthsAgo.setHours(0, 0, 0, 0)

    const monthlyTrend = await Payment.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            currency: '$currency',
          },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ])

    // Recent 5 payments
    const recent = await Payment.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .lean()

    res.json({
      total,
      completed,
      pending,
      failed,
      expired,
      revenueByCurrency,
      monthlyTrend,
      recent,
    })
  } catch (err) {
    console.error('getPaymentStats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updatePayment(req, res) {
  try {
    const { status, notes } = req.body
    const update = {}
    if (status) update.status = status
    if (notes !== undefined) update.notes = notes

    const payment = await Payment.findByIdAndUpdate(req.params.id, update, { new: true })
    if (!payment) return res.status(404).json({ error: 'Payment not found' })

    await logActivity({
      category: 'payment',
      action: 'payment.update',
      message: `Payment ${payment.invoiceNo || payment._id} updated via portal`,
      req,
      meta: { paymentId: payment._id, changes: update },
    })

    res.json(payment)
  } catch (err) {
    console.error('updatePayment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ──────────────────────────────────────────────
// PAYMENT LINKS
// ──────────────────────────────────────────────

export async function listPaymentLinks(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20))
    const { status, search } = req.query

    const filter = {}
    if (status) filter.status = status

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [
        { payeeName: regex },
        { payeeEmail: regex },
        { description: regex },
        { invoiceNo: regex },
      ]
    }

    const total = await PaymentLink.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await PaymentLink.find(filter)
      .populate('student', 'name rollNo')
      .populate('familyId', 'familyCode primaryGuardian')
      .populate('studentIds', 'name rollNo status')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('listPaymentLinks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createPaymentLink(req, res) {
  try {
    const { payeeName, payeeEmail, payeePhone, description, amount, currency, notes, expiresAfterPayment, items, listType, student, familyId, studentIds, taxType, taxValue } = req.body

    if (!description || !amount) {
      return res.status(400).json({ error: 'description and amount are required' })
    }

    // Generate invoice number: HO-YYYYMM-XXXX
    const now = new Date()
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
    const hex = Math.random().toString(16).substring(2, 6).toUpperCase()
    const invoiceNo = `HO-${ym}-${hex}`

    let resolvedPayeeName = payeeName || ''
    let resolvedEmail = payeeEmail || ''
    let resolvedPhone = payeePhone || ''

    // Auto-fill from family guardian if linked
    if (familyId) {
      const family = await Family.findById(familyId).lean()
      if (family?.primaryGuardian) {
        if (!resolvedPayeeName) resolvedPayeeName = family.primaryGuardian.name || ''
        if (!resolvedEmail) resolvedEmail = family.primaryGuardian.email || ''
        if (!resolvedPhone) resolvedPhone = family.primaryGuardian.phone || ''
      }
    }

    // Auto-fill from student if single student linked (no family)
    if (!familyId && student) {
      const stu = await Student.findById(student).select('name email phone guardians').lean()
      if (stu) {
        if (!resolvedPayeeName) resolvedPayeeName = stu.guardians?.[0]?.name || stu.name || ''
        if (!resolvedEmail) resolvedEmail = stu.email || stu.guardians?.[0]?.email || ''
        if (!resolvedPhone) resolvedPhone = stu.phone || stu.guardians?.[0]?.phone || ''
      }
    }

    if (!resolvedPayeeName) {
      return res.status(400).json({ error: 'payeeName is required (provide it or link a family/student)' })
    }

    const linkData = {
      payeeName: resolvedPayeeName,
      payeeEmail: resolvedEmail,
      payeePhone: resolvedPhone,
      description,
      amount,
      currency: currency || 'PKR',
      taxType: ['percentage', 'fixed'].includes(taxType) ? taxType : 'none',
      taxValue: ['percentage', 'fixed'].includes(taxType) ? Math.max(0, Number(taxValue) || 0) : 0,
      notes: notes || '',
      expiresAfterPayment: expiresAfterPayment !== undefined ? expiresAfterPayment : true,
      items: items || [],
      listType: listType || 'bullet',
      invoiceNo,
    }

    if (student) linkData.student = student
    if (familyId) linkData.familyId = familyId
    if (studentIds?.length) linkData.studentIds = studentIds

    const link = await PaymentLink.create(linkData)

    await logActivity({
      category: 'payment_link',
      action: 'payment_link.create',
      message: `Payment link created for ${resolvedPayeeName} — ${invoiceNo}`,
      req,
      meta: { paymentLinkId: link._id, invoiceNo, familyId, studentIds },
    })

    res.status(201).json(link)
  } catch (err) {
    console.error('createPaymentLink error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getPaymentLinkHistory(req, res) {
  try {
    const link = await PaymentLink.findById(req.params.id)
      .populate('student', 'name rollNo')
      .lean()

    if (!link) return res.status(404).json({ error: 'Payment link not found' })

    const payments = await Payment.find({ paymentLink: link._id })
      .sort({ createdAt: -1 })
      .lean()

    const stats = {
      total: payments.length,
      completed: payments.filter(p => p.status === 'completed').length,
      totalPaid: payments
        .filter(p => p.status === 'completed')
        .reduce((sum, p) => sum + p.amount, 0),
    }

    res.json({ link, payments, stats })
  } catch (err) {
    console.error('getPaymentLinkHistory error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function sendPaymentLinkEmail(req, res) {
  try {
    const link = await PaymentLink.findById(req.params.id)
    if (!link) return res.status(404).json({ error: 'Payment link not found' })

    if (!link.payeeEmail) {
      return res.status(400).json({ error: 'No email address on this payment link' })
    }

    const { paymentLinkEmail, sendToUser, paymentLinkAdminEmail, notifyAdmin } = await import('../services/mailer.js')

    const payUrl = `${process.env.FRONTEND_URL}/pay/${link.token}`

    // Send to payee
    const userHtml = paymentLinkEmail({
      payeeName: link.payeeName,
      description: link.description,
      amount: link.amount,
      currency: link.currency,
      items: link.items,
      listType: link.listType,
      payUrl,
      invoiceNo: link.invoiceNo,
    })

    await sendToUser({
      to: link.payeeEmail,
      subject: `Payment Link — ${link.description}`,
      html: userHtml,
    })

    // Notify admin
    const adminHtml = paymentLinkAdminEmail({
      payeeName: link.payeeName,
      payeeEmail: link.payeeEmail,
      description: link.description,
      amount: link.amount,
      currency: link.currency,
      invoiceNo: link.invoiceNo,
    })

    await notifyAdmin({
      subject: `Payment Link Sent — ${link.invoiceNo}`,
      html: adminHtml,
    })

    link.emailSent = true
    await link.save()

    await logActivity({
      category: 'payment_link',
      action: 'payment_link.send',
      message: `Payment link email sent to ${link.payeeEmail}`,
      req,
      meta: { paymentLinkId: link._id, invoiceNo: link.invoiceNo },
    })

    res.json({ message: 'Email sent successfully' })
  } catch (err) {
    console.error('sendPaymentLinkEmail error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deletePaymentLink(req, res) {
  try {
    const link = await PaymentLink.findByIdAndDelete(req.params.id)
    if (!link) return res.status(404).json({ error: 'Payment link not found' })

    await logActivity({
      category: 'payment_link',
      action: 'payment_link.delete',
      message: `Payment link ${link.invoiceNo} deleted`,
      req,
      meta: { paymentLinkId: link._id },
    })

    res.json({ message: 'Payment link deleted' })
  } catch (err) {
    console.error('deletePaymentLink error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ──────────────────────────────────────────────
// DISCOUNT CODES
// ──────────────────────────────────────────────

export async function listDiscountCodes(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30))
    const { currency, usageType, isActive } = req.query
    const filter = {}

    if (currency) filter.currency = currency
    if (usageType) filter.usageType = usageType
    if (isActive === 'true' || isActive === 'false') filter.isActive = isActive === 'true'

    const total = await DiscountCode.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await DiscountCode.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('listDiscountCodes error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createDiscountCode(req, res) {
  try {
    const { code, discountAmount, currency, usageType, description } = req.body

    if (!discountAmount || !currency) {
      return res.status(400).json({ error: 'discountAmount and currency are required' })
    }

    const data = {
      discountAmount,
      currency,
      usageType: usageType || 'one_time',
      description: description || '',
    }

    if (code) data.code = code.toUpperCase().trim()

    const newCode = await DiscountCode.create(data)

    await logActivity({
      category: 'discount_code',
      action: 'discount_code.create',
      message: `Discount code ${newCode.code} created (${newCode.discountAmount} ${newCode.currency})`,
      req,
      meta: { discountCodeId: newCode._id },
    })

    res.status(201).json(newCode)
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Discount code already exists' })
    }
    console.error('createDiscountCode error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function toggleDiscountCode(req, res) {
  try {
    const code = await DiscountCode.findById(req.params.id)
    if (!code) return res.status(404).json({ error: 'Discount code not found' })

    code.isActive = !code.isActive
    await code.save()

    await logActivity({
      category: 'discount_code',
      action: 'discount_code.update',
      message: `Discount code ${code.code} ${code.isActive ? 'activated' : 'deactivated'}`,
      req,
      meta: { discountCodeId: code._id, isActive: code.isActive },
    })

    res.json(code)
  } catch (err) {
    console.error('toggleDiscountCode error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteDiscountCode(req, res) {
  try {
    const code = await DiscountCode.findByIdAndDelete(req.params.id)
    if (!code) return res.status(404).json({ error: 'Discount code not found' })

    await logActivity({
      category: 'discount_code',
      action: 'discount_code.delete',
      message: `Discount code ${code.code} deleted`,
      req,
      meta: { discountCodeId: code._id },
    })

    res.json({ message: 'Discount code deleted' })
  } catch (err) {
    console.error('deleteDiscountCode error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ──────────────────────────────────────────────
// PLANS
// ──────────────────────────────────────────────

export async function listAllPlans(req, res) {
  try {
    const plans = await Plan.find().sort({ price: 1 }).lean()
    res.json(plans)
  } catch (err) {
    console.error('listAllPlans error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updatePlan(req, res) {
  try {
    const { price, prices, name, sessions, duration, features, popular, active } = req.body
    const update = {}

    if (price !== undefined) {
      if (price < 20) return res.status(400).json({ error: 'Price must be at least 20' })
      update.price = price
    }
    if (prices !== undefined) update.prices = prices
    if (name !== undefined) update.name = name
    if (sessions !== undefined) update.sessions = sessions
    if (duration !== undefined) update.duration = duration
    if (features !== undefined) update.features = features
    if (popular !== undefined) update.popular = popular
    if (active !== undefined) update.active = active

    const plan = await Plan.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
    if (!plan) return res.status(404).json({ error: 'Plan not found' })

    await logActivity({
      category: 'plan',
      action: 'plan.update',
      message: `Plan "${plan.name}" updated via portal`,
      req,
      meta: { planId: plan._id, changes: update },
    })

    res.json(plan)
  } catch (err) {
    console.error('updatePlan error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
