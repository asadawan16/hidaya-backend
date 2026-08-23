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

// The portal account that owns an advance, whichever subject it belongs to —
// this is who gets notified about approvals, repayments and cancellations.
async function subjectUserId(advance) {
  if (advance.subjectType === 'staff') return advance.userId || null
  return tutorUserId(advance.tutorId)
}

// Display name for logs/notifications without another round trip when populated.
const subjectName = (advance) =>
  advance?.subjectType === 'staff'
    ? (advance.userId?.displayName || advance.userId?.email || 'A staff member')
    : (advance.tutorId?.name || 'A tutor')

// Populate both subject refs — only one is ever set, so the unused one is null.
const withSubject = (query) => query
  .populate('tutorId', 'name tutorId')
  .populate('userId', 'displayName email')

// Mongo filter selecting only the caller's OWN advances. Tutors are matched by
// their linked tutor profile, everyone else by their user id. Returns null when
// the account has no advance subject at all.
function ownSubjectFilter(user, userId) {
  if (user?.linkedTutorId) return { subjectType: 'tutor', tutorId: user.linkedTutorId }
  if (userId) return { subjectType: 'staff', userId }
  return null
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
    const { tutorId, userId, subjectType, status, type, mine } = req.query

    const filter = {}
    // Tutors only ever see their own advances, regardless of query params.
    // `mine=1` (the My Advances page) self-scopes any account — tutor or staff.
    if (req.user.linkedTutorId) {
      filter.subjectType = 'tutor'
      filter.tutorId = req.user.linkedTutorId
    } else if (mine === '1' || mine === 'true') {
      const own = ownSubjectFilter(req.user, req.userId)
      if (!own) return res.json({ records: [], total: 0, page: 1, pages: 1, stats: {} })
      Object.assign(filter, own)
    } else {
      if (subjectType) filter.subjectType = subjectType
      if (tutorId) { filter.tutorId = tutorId; filter.subjectType = 'tutor' }
      if (userId) { filter.userId = userId; filter.subjectType = 'staff' }
    }
    if (status) filter.status = status
    if (type) filter.type = type

    const total = await Advance.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await withSubject(Advance.find(filter))
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
    if (filter.userId) matchStage.userId = new mongoose.Types.ObjectId(String(filter.userId))
    if (filter.subjectType) matchStage.subjectType = filter.subjectType
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
    const { tutorId, userId, type, totalAmount, currency, installmentAmount, installmentFrequency, reason, startDate } = req.body
    // Subject is whichever ref was supplied; explicit subjectType wins so a bad
    // pairing (staff + tutorId) fails validation instead of silently mis-filing.
    const isStaff = req.body.subjectType === 'staff' || (!tutorId && !!userId)
    const subjectRef = isStaff ? userId : tutorId

    if (!subjectRef || !type || !totalAmount || !installmentAmount || !startDate) {
      return res.status(400).json({
        error: `${isStaff ? 'userId' : 'tutorId'}, type, totalAmount, installmentAmount, and startDate are required`,
      })
    }
    if (isStaff) {
      const staffUser = await User.findById(userId).select('_id').lean()
      if (!staffUser) return res.status(404).json({ error: 'Staff member not found' })
    }

    const advance = await Advance.create({
      subjectType: isStaff ? 'staff' : 'tutor',
      ...(isStaff ? { userId } : { tutorId }),
      type, totalAmount,
      currency: currency || 'PKR',
      installmentAmount,
      installmentFrequency: installmentFrequency || 'monthly',
      reason: reason || '',
      startDate: new Date(startDate),
      approvedBy: req.userId,
    })

    const populated = await withSubject(Advance.findById(advance._id))
      .populate('approvedBy', 'displayName')
      .lean()

    await logActivity({
      level: 'info', category: 'finance', action: 'advance_created',
      message: `Advance/loan created for ${isStaff ? 'staff' : 'tutor'} ${subjectName(populated)}: ${totalAmount}`,
      req, meta: { advanceId: advance._id },
    })

    const uid = isStaff ? userId : await tutorUserId(tutorId)
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

// ─── A tutor or staff member requests an advance for themselves (→ requested) ───
export async function requestAdvance(req, res) {
  try {
    // Tutors file against their tutor profile; everyone else against their user
    // account. Students are excluded — they aren't on payroll.
    if (req.user.linkedStudentId) {
      return res.status(400).json({ error: 'Student accounts cannot request salary advances' })
    }
    const own = ownSubjectFilter(req.user, req.userId)
    if (!own) return res.status(400).json({ error: 'Your account cannot request an advance' })

    const { type, totalAmount, currency, installmentAmount, installmentFrequency, reason, startDate } = req.body
    const amount = Number(totalAmount)
    if (!amount || amount <= 0) return res.status(400).json({ error: 'A valid amount is required' })

    const advance = await Advance.create({
      ...own,
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

    const populated = await withSubject(Advance.findById(advance._id)).lean()
    const requesterName = subjectName(populated)

    await logActivity({
      level: 'info', category: 'finance', action: 'advance_requested',
      message: `Advance requested by ${own.subjectType} ${requesterName}: ${amount}`, req,
      meta: { advanceId: advance._id },
    })

    await notifyReviewers({
      type: 'advance_requested',
      title: 'Advance Requested',
      body: `${requesterName} requested an advance of ${advance.currency} ${amount.toLocaleString()}.`,
      payload: { advanceId: advance._id },
      exceptUserId: req.userId,
    })
    REVIEWER_ROLES.forEach(role => emitToRole(role, 'advance_request', {
      advanceId: advance._id, tutorName: requesterName, subjectType: own.subjectType, amount,
    }))

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

    const populated = await withSubject(Advance.findById(advance._id))
      .populate('approvedBy', 'displayName').lean()

    const uid = await subjectUserId(advance)
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

    const populated = await withSubject(Advance.findById(advance._id)).lean()

    const uid = await subjectUserId(advance)
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

    const populated = await withSubject(Advance.findById(advance._id))
      .populate('approvedBy', 'displayName')
      .lean()

    const uid = await subjectUserId(advance)
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
    const advance = await withSubject(Advance.findById(req.params.id))
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
      message: `Advance ${advance._id} deleted (${advance.subjectType} ${advance.tutorId || advance.userId})`,
      req, meta: { advanceId: advance._id },
    })

    res.json({ success: true })
  } catch (err) {
    console.error('Delete advance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/advances/by-person — one row per person (tutor OR staff) who has
// ever taken an advance, with lifetime totals so management can deep-dive a
// person's history instead of scrolling a flat list of individual advances.
export async function listAdvancesByPerson(req, res) {
  try {
    const match = {}
    // Tutors only ever see themselves, regardless of query params.
    if (req.user.linkedTutorId) match.tutorId = new mongoose.Types.ObjectId(String(req.user.linkedTutorId))
    if (req.query.type) match.type = req.query.type
    if (['tutor', 'staff'].includes(req.query.subjectType)) match.subjectType = req.query.subjectType

    const rows = await Advance.aggregate([
      ...(Object.keys(match).length ? [{ $match: match }] : []),
      {
        // Group on the subject that's actually set. Legacy rows predate
        // subjectType, so a missing value reads as 'tutor' (see the
        // migrate-advance-subject-type backfill).
        $group: {
          _id: {
            subjectType: { $ifNull: ['$subjectType', 'tutor'] },
            ref: { $ifNull: ['$tutorId', '$userId'] },
          },
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

    const tutorRefs = rows.filter(r => r._id.subjectType !== 'staff').map(r => r._id.ref)
    const staffRefs = rows.filter(r => r._id.subjectType === 'staff').map(r => r._id.ref)

    const [tutors, staff] = await Promise.all([
      TutorProfile.find({ _id: { $in: tutorRefs } }).select('name tutorId status').lean(),
      User.find({ _id: { $in: staffRefs } }).select('displayName email status').lean(),
    ])
    const tutorById = new Map(tutors.map(t => [String(t._id), t]))
    const staffById = new Map(staff.map(u => [String(u._id), u]))

    // Both subject kinds are flattened to a common `person` shape so the UI
    // renders one table; `tutorId` is kept for the existing tutor drill-down.
    const records = rows.map(r => {
      const isStaff = r._id.subjectType === 'staff'
      const ref = String(r._id.ref)
      const tutor = isStaff ? null : (tutorById.get(ref) || { _id: r._id.ref, name: 'Unknown Tutor', tutorId: '' })
      const user = isStaff ? (staffById.get(ref) || { _id: r._id.ref, displayName: 'Unknown Staff', email: '' }) : null
      return {
        subjectType: isStaff ? 'staff' : 'tutor',
        subjectId: r._id.ref,
        person: {
          _id: r._id.ref,
          name: isStaff ? (user.displayName || user.email) : tutor.name,
          code: isStaff ? (user.email || '') : (tutor.tutorId || ''),
        },
        tutorId: tutor,
        userId: user,
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
      }
    })

    res.json({ records, total: records.length })
  } catch (err) {
    console.error('Advances by person error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
