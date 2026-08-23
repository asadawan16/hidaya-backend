import mongoose from 'mongoose'
import Advance from '../models/Advance.js'
import TutorProfile from '../models/TutorProfile.js'
import User from '../models/User.js'
import Notification from '../models/Notification.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'
import { emitToUser, emitToRole } from '../config/socket.js'

async function tutorUserId(tutorId) {
  const u = await User.findOne({ linkedTutorId: tutorId, status: 'active' }).select('_id').lean()
  return u?._id || null
}

const REVIEWER_ROLES = ['super_admin', 'admin']

// Persist + push a notification to all advance reviewers (except the actor).
async function notifyReviewers({ type, title, body, payload, exceptUserId }) {
  try {
    const allUsers = await User.find({ status: 'active' }).populate('roles', 'key').select('_id roles').lean()
    const targets = allUsers.filter(u =>
      u.roles?.some(r => REVIEWER_ROLES.includes(r.key)) && String(u._id) !== String(exceptUserId),
    )
    if (targets.length) {
      const created = await Notification.insertMany(targets.map(u => ({ userId: u._id, type, title, body, payload })))
      created.forEach(n => emitToUser(n.userId, 'notification', n))
    }
  } catch (e) { console.error('notify reviewers failed:', e.message) }
}

export async function listAdvances(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20))
    const { tutorId, status, type } = req.query

    const filter = {}
    // Tutors only ever see their own advances, regardless of query params.
    if (req.user.linkedTutorId) filter.tutorId = req.user.linkedTutorId
    else if (tutorId) filter.tutorId = tutorId
    if (status) filter.status = status
    if (type) filter.type = type

    const total = await Advance.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await Advance.find(filter)
      .populate('tutorId', 'name tutorId')
      .populate('approvedBy', 'displayName')
      .populate('requestedBy', 'displayName')
      .populate('reviewedBy', 'displayName')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    // Aggregate stats across the whole filtered set (not just the current page).
    const matchStage = {}
    if (filter.tutorId) matchStage.tutorId = new mongoose.Types.ObjectId(String(filter.tutorId))
    if (filter.status) matchStage.status = filter.status
    if (filter.type) matchStage.type = filter.type
    const [agg] = await Advance.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          activeCount: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          totalOutstanding: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, '$remainingBalance', 0] } },
          totalRepaid: { $sum: '$amountRepaid' },
        },
      },
    ])
    const cur = await Advance.findOne(filter).select('currency').lean()
    const stats = {
      activeCount: agg?.activeCount || 0,
      totalOutstanding: agg?.totalOutstanding || 0,
      totalRepaid: agg?.totalRepaid || 0,
      currency: cur?.currency || 'PKR',
    }

    res.json({ records, total, page: safePage, pages, stats })
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

// ─── Tutor requests an advance (status: requested) ───
export async function requestAdvance(req, res) {
  try {
    const tutorId = req.user.linkedTutorId
    if (!tutorId) return res.status(400).json({ error: 'Your account is not linked to a tutor profile' })

    const { type, totalAmount, currency, installmentAmount, installmentFrequency, reason, startDate } = req.body
    const amount = Number(totalAmount)
    if (!amount || amount <= 0) return res.status(400).json({ error: 'A valid amount is required' })

    const advance = await Advance.create({
      tutorId,
      type: type || 'short_term',
      totalAmount: amount,
      currency: currency || 'PKR',
      // Terms can be adjusted by the reviewer on approval; default to a single monthly installment.
      installmentAmount: Number(installmentAmount) > 0 ? Number(installmentAmount) : amount,
      installmentFrequency: installmentFrequency || 'monthly',
      reason: reason || '',
      startDate: startDate ? new Date(startDate) : new Date(),
      status: 'requested',
      requestedBy: req.userId,
    })

    await logActivity({
      level: 'info', category: 'finance', action: 'advance_requested',
      message: `Advance requested by tutor ${tutorId}: ${amount}`, req,
      meta: { advanceId: advance._id },
    })

    const populated = await Advance.findById(advance._id).populate('tutorId', 'name tutorId').lean()
    const tutorName = populated?.tutorId?.name || 'A tutor'
    await notifyReviewers({
      type: 'advance_requested',
      title: 'Advance Requested',
      body: `${tutorName} requested an advance of ${advance.currency} ${amount.toLocaleString()}.`,
      payload: { advanceId: advance._id },
      exceptUserId: req.userId,
    })
    REVIEWER_ROLES.forEach(role => emitToRole(role, 'advance_request', { advanceId: advance._id, tutorName, amount }))

    res.status(201).json(populated)
  } catch (err) {
    console.error('Request advance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Approve a requested advance (→ active, flows into salary deductions) ───
export async function approveAdvance(req, res) {
  try {
    const advance = await Advance.findById(req.params.id)
    if (!advance) return res.status(404).json({ error: 'Advance not found' })
    if (advance.status !== 'requested') return res.status(400).json({ error: 'Only requested advances can be approved' })

    const { installmentAmount, installmentFrequency, startDate } = req.body
    if (Number(installmentAmount) > 0) advance.installmentAmount = Number(installmentAmount)
    if (installmentFrequency) advance.installmentFrequency = installmentFrequency
    if (startDate) advance.startDate = new Date(startDate)
    advance.status = 'active'
    advance.approvedBy = req.userId
    advance.reviewedBy = req.userId
    advance.reviewedAt = new Date()
    await advance.save()

    await logActivity({
      level: 'info', category: 'finance', action: 'advance_approved',
      message: `Advance ${advance._id} approved`, req, meta: { advanceId: advance._id },
    })

    const populated = await Advance.findById(advance._id)
      .populate('tutorId', 'name tutorId').populate('approvedBy', 'displayName').lean()

    const uid = await tutorUserId(advance.tutorId)
    if (uid) {
      const n = await createNotification({
        userId: uid, type: 'advance_approved', title: 'Advance Approved',
        body: `Your advance of ${advance.currency} ${Number(advance.totalAmount).toLocaleString()} was approved. It will be deducted from your salary (${advance.installmentFrequency}).`,
        payload: { advanceId: advance._id },
      })
      if (n) emitToUser(uid, 'advance_reviewed', { advanceId: advance._id, status: 'approved' })
    }

    res.json(populated)
  } catch (err) {
    console.error('Approve advance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Reject a requested advance ───
export async function rejectAdvance(req, res) {
  try {
    const advance = await Advance.findById(req.params.id)
    if (!advance) return res.status(404).json({ error: 'Advance not found' })
    if (advance.status !== 'requested') return res.status(400).json({ error: 'Only requested advances can be rejected' })

    advance.status = 'rejected'
    advance.reviewedBy = req.userId
    advance.reviewedAt = new Date()
    advance.rejectionReason = req.body.rejectionReason || ''
    await advance.save()

    await logActivity({
      level: 'info', category: 'finance', action: 'advance_rejected',
      message: `Advance ${advance._id} rejected`, req, meta: { advanceId: advance._id },
    })

    const populated = await Advance.findById(advance._id).populate('tutorId', 'name tutorId').lean()

    const uid = await tutorUserId(advance.tutorId)
    if (uid) {
      const n = await createNotification({
        userId: uid, type: 'advance_rejected', title: 'Advance Rejected',
        body: `Your advance request was rejected.${advance.rejectionReason ? ' Reason: ' + advance.rejectionReason : ''}`,
        payload: { advanceId: advance._id },
      })
      if (n) emitToUser(uid, 'advance_reviewed', { advanceId: advance._id, status: 'rejected' })
    }

    res.json(populated)
  } catch (err) {
    console.error('Reject advance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateAdvance(req, res) {
  try {
    const advance = await Advance.findById(req.params.id)
    if (!advance) return res.status(404).json({ error: 'Advance not found' })

    const {
      status, type, totalAmount, currency, installmentAmount, installmentFrequency,
      reason, startDate, repayment, removeInstallmentId,
    } = req.body

    if (status === 'cancelled') {
      advance.status = 'cancelled'
    }
    // Editable core fields (advance.manage) — only applied when provided.
    if (type) advance.type = type
    if (currency) advance.currency = currency
    if (reason !== undefined) advance.reason = reason
    if (startDate) advance.startDate = new Date(startDate)
    if (totalAmount != null && Number(totalAmount) > 0) advance.totalAmount = Number(totalAmount)
    if (installmentAmount) advance.installmentAmount = installmentAmount
    if (installmentFrequency) advance.installmentFrequency = installmentFrequency

    // Delete a recorded repayment (from the history timeline).
    if (removeInstallmentId) {
      const inst = advance.installments.id(removeInstallmentId)
      if (inst) {
        advance.amountRepaid = Math.max(0, advance.amountRepaid - inst.amount)
        inst.deleteOne()
        // Reopen a previously-settled advance if it now has an outstanding balance again.
        if (advance.status === 'fully_paid') advance.status = 'active'
      }
    }

    // Manual repayment recording
    if (repayment && repayment.amount > 0) {
      advance.installments.push({
        date: repayment.date ? new Date(repayment.date) : new Date(),
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
      .populate('requestedBy', 'displayName')
      .populate('reviewedBy', 'displayName')
      .lean()

    if (!advance) return res.status(404).json({ error: 'Advance not found' })
    res.json(advance)
  } catch (err) {
    console.error('Get advance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteAdvance(req, res) {
  try {
    const advance = await Advance.findById(req.params.id)
    if (!advance) return res.status(404).json({ error: 'Advance not found' })

    await advance.deleteOne()

    await logActivity({
      level: 'warn', category: 'finance', action: 'advance_deleted',
      message: `Advance ${advance._id} deleted (tutor ${advance.tutorId})`,
      req, meta: { advanceId: advance._id },
    })

    res.json({ success: true })
  } catch (err) {
    console.error('Delete advance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/advances/by-person — one row per tutor who has ever taken an
// advance, with lifetime totals so management can deep-dive a person's history
// instead of scrolling a flat list of individual advances.
export async function listAdvancesByPerson(req, res) {
  try {
    const match = {}
    // Tutors only ever see themselves, regardless of query params.
    if (req.user.linkedTutorId) match.tutorId = new mongoose.Types.ObjectId(String(req.user.linkedTutorId))
    if (req.query.type) match.type = req.query.type

    const rows = await Advance.aggregate([
      ...(Object.keys(match).length ? [{ $match: match }] : []),
      {
        $group: {
          _id: '$tutorId',
          currency: { $first: '$currency' },
          advanceCount: { $sum: 1 },
          activeCount: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          requestedCount: { $sum: { $cond: [{ $eq: ['$status', 'requested'] }, 1, 0] } },
          fullyPaidCount: { $sum: { $cond: [{ $eq: ['$status', 'fully_paid'] }, 1, 0] } },
          // "Taken" excludes rejected/cancelled — money that never left the till.
          totalTaken: { $sum: { $cond: [{ $in: ['$status', ['active', 'fully_paid']] }, '$totalAmount', 0] } },
          totalRepaid: { $sum: '$amountRepaid' },
          outstanding: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, '$remainingBalance', 0] } },
          firstAdvanceAt: { $min: '$startDate' },
          lastAdvanceAt: { $max: '$startDate' },
          installmentCount: { $sum: { $size: { $ifNull: ['$installments', []] } } },
        },
      },
      { $sort: { outstanding: -1, totalTaken: -1 } },
    ])

    const tutors = await TutorProfile.find({ _id: { $in: rows.map(r => r._id) } })
      .select('name tutorId status')
      .lean()
    const byId = new Map(tutors.map(t => [String(t._id), t]))

    const records = rows.map(r => ({
      tutorId: byId.get(String(r._id)) || { _id: r._id, name: 'Unknown Tutor', tutorId: '' },
      currency: r.currency || 'PKR',
      advanceCount: r.advanceCount,
      activeCount: r.activeCount,
      requestedCount: r.requestedCount,
      fullyPaidCount: r.fullyPaidCount,
      totalTaken: r.totalTaken,
      totalRepaid: r.totalRepaid,
      outstanding: r.outstanding,
      installmentCount: r.installmentCount,
      firstAdvanceAt: r.firstAdvanceAt,
      lastAdvanceAt: r.lastAdvanceAt,
    }))

    res.json({ records, total: records.length })
  } catch (err) {
    console.error('Advances by person error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
