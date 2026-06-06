import Enrollment from '../models/Enrollment.js'
import { notifyAdmin, sendToUser, enrollmentEmail, enrollmentConfirmationEmail } from '../services/mailer.js'
import { logActivity } from '../utils/activityLogger.js'

export async function create(req, res) {
  try {
    const { name, email, phone, message, source } = req.body
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' })
    }

    const enrollment = await Enrollment.create({
      name: name.trim(),
      email: email.trim(),
      phone: phone?.trim(),
      message: message?.trim(),
      source: source || 'hero_form',
    })

    const enrollmentData = enrollment.toObject()

    logActivity({
      level: 'info',
      category: 'enrollment',
      action: 'enrollment_created',
      message: `New enrollment from ${name} (${email}) via ${source || 'hero_form'}`,
      req,
      meta: { enrollmentId: enrollment._id, source: source || 'hero_form' },
    })

    // Notify admin via email (non-blocking)
    notifyAdmin(enrollmentEmail(enrollmentData)).catch(() => {})

    // Send confirmation to user (non-blocking)
    const userEmail = enrollmentConfirmationEmail(enrollmentData)
    sendToUser({ to: enrollmentData.email, ...userEmail }).catch(() => {})

    res.status(201).json({ message: 'Submitted successfully', id: enrollment._id })
  } catch (err) {
    console.error('Enrollment create error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function list(req, res) {
  try {
    const { status, source, page = 1, limit = 20, startDate, endDate } = req.query
    const filter = {}
    if (status) filter.status = status
    if (source) filter.source = source
    if (startDate || endDate) {
      filter.createdAt = {}
      if (startDate) filter.createdAt.$gte = new Date(startDate)
      if (endDate) filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999))
    }

    const total = await Enrollment.countDocuments(filter)
    const enrollments = await Enrollment.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))

    res.json({ enrollments, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    console.error('Enrollment list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function stats(req, res) {
  try {
    const { startDate, endDate } = req.query
    const dateFilter = {}
    if (startDate || endDate) {
      dateFilter.createdAt = {}
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate)
      if (endDate) dateFilter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999))
    }

    const [total, newCount, contacted, enrolled, closed] = await Promise.all([
      Enrollment.countDocuments(dateFilter),
      Enrollment.countDocuments({ status: 'new', ...dateFilter }),
      Enrollment.countDocuments({ status: 'contacted', ...dateFilter }),
      Enrollment.countDocuments({ status: 'enrolled', ...dateFilter }),
      Enrollment.countDocuments({ status: 'closed', ...dateFilter }),
    ])

    // Source breakdown
    const bySource = await Enrollment.aggregate([
      { $match: dateFilter },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ])
    const sourceMap = {}
    bySource.forEach(s => { sourceMap[s._id] = s.count })

    // Monthly trend
    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    const monthlyDateFilter = dateFilter.createdAt ? dateFilter : { createdAt: { $gte: sixMonthsAgo } }

    const monthly = await Enrollment.aggregate([
      { $match: monthlyDateFilter },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])

    // Recent submissions
    const recent = await Enrollment.find(dateFilter).sort({ createdAt: -1 }).limit(5)

    res.json({ total, new: newCount, contacted, enrolled, closed, bySource: sourceMap, monthly, recent })
  } catch (err) {
    console.error('Enrollment stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateStatus(req, res) {
  try {
    const { status } = req.body
    const enrollment = await Enrollment.findByIdAndUpdate(req.params.id, { status }, { new: true })
    if (!enrollment) return res.status(404).json({ error: 'Not found' })
    res.json(enrollment)
  } catch (err) {
    console.error('Enrollment update error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
