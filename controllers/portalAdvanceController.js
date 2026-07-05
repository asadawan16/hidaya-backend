import Advance from '../models/Advance.js'
import User from '../models/User.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'

async function tutorUserId(tutorId) {
  const u = await User.findOne({ linkedTutorId: tutorId, status: 'active' }).select('_id').lean()
  return u?._id || null
}

export async function listAdvances(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20))
    const { tutorId, status } = req.query

    const filter = {}
    if (tutorId) filter.tutorId = tutorId
    if (status) filter.status = status

    const total = await Advance.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await Advance.find(filter)
      .populate('tutorId', 'name tutorId')
      .populate('approvedBy', 'displayName')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List advances error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createAdvance(req, res) {
  try {
    const { tutorId, type, totalAmount, currency, installmentAmount, installmentFrequency, reason, startDate } = req.body
    if (!tutorId || !type || !totalAmount || !installmentAmount || !startDate) {
      return res.status(400).json({ error: 'tutorId, type, totalAmount, installmentAmount, and startDate are required' })
    }

    const advance = await Advance.create({
      tutorId, type, totalAmount,
      currency: currency || 'PKR',
      installmentAmount,
      installmentFrequency: installmentFrequency || 'monthly',
      reason: reason || '',
      startDate: new Date(startDate),
      approvedBy: req.userId,
    })

    await logActivity({
      level: 'info', category: 'finance', action: 'advance_created',
      message: `Advance/loan created for tutor ${tutorId}: ${totalAmount}`,
      req,
    })

    const populated = await Advance.findById(advance._id)
      .populate('tutorId', 'name tutorId')
      .populate('approvedBy', 'displayName')
      .lean()

    const uid = await tutorUserId(tutorId)
    if (uid) {
      await createNotification({
        userId: uid,
        type: 'advance_created',
        title: 'Advance Approved',
        body: `A ${type} of ${currency || 'PKR'} ${Number(totalAmount).toLocaleString()} has been approved for you (repaid ${installmentFrequency || 'monthly'}).`,
        payload: { advanceId: advance._id },
      })
    }

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create advance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateAdvance(req, res) {
  try {
    const advance = await Advance.findById(req.params.id)
    if (!advance) return res.status(404).json({ error: 'Advance not found' })

    const { status, installmentAmount, installmentFrequency, repayment } = req.body

    if (status === 'cancelled') {
      advance.status = 'cancelled'
    }
    if (installmentAmount) advance.installmentAmount = installmentAmount
    if (installmentFrequency) advance.installmentFrequency = installmentFrequency

    // Manual repayment recording
    if (repayment && repayment.amount > 0) {
      advance.installments.push({
        date: new Date(),
        amount: repayment.amount,
        note: repayment.note || 'Manual repayment',
      })
      advance.amountRepaid += repayment.amount
    }

    await advance.save()

    const populated = await Advance.findById(advance._id)
      .populate('tutorId', 'name tutorId')
      .populate('approvedBy', 'displayName')
      .lean()

    const uid = await tutorUserId(advance.tutorId)
    if (uid) {
      const what = status === 'cancelled'
        ? 'Your advance has been cancelled.'
        : repayment?.amount > 0
          ? `A repayment of ${advance.currency} ${Number(repayment.amount).toLocaleString()} was recorded on your advance.`
          : 'Your advance details were updated.'
      await createNotification({
        userId: uid,
        type: 'advance_updated',
        title: 'Advance Updated',
        body: what,
        payload: { advanceId: advance._id },
      })
    }

    res.json(populated)
  } catch (err) {
    console.error('Update advance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getAdvance(req, res) {
  try {
    const advance = await Advance.findById(req.params.id)
      .populate('tutorId', 'name tutorId')
      .populate('approvedBy', 'displayName')
      .lean()

    if (!advance) return res.status(404).json({ error: 'Advance not found' })
    res.json(advance)
  } catch (err) {
    console.error('Get advance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
