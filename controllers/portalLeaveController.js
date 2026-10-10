import mongoose from 'mongoose'
import LeaveRequest from '../models/LeaveRequest.js'
import TutorAttendance from '../models/TutorAttendance.js'
import TutorProfile from '../models/TutorProfile.js'
import Notification from '../models/Notification.js'
import User from '../models/User.js'
import { logActivity } from '../utils/activityLogger.js'
import { emitToUser, emitToRole } from '../config/socket.js'
import { createNotification } from './portalNotificationController.js'

const REVIEWER_ROLES = ['super_admin', 'admin', 'qci', 'principal', 'coordinator']

// ── Subject helpers ──────────────────────────────────────────────────────────
// A leave request belongs to a tutor (tutorId) or a management/staff user
// (userId) — same split as attendance and advances.

// The caller's own subject — tutors have a linked profile; everyone else (staff /
// management) is scoped by their own userId.
function selfSubject(req) {
  if (req.user.linkedTutorId) return { subjectType: 'tutor', tutorId: req.user.linkedTutorId }
  return { subjectType: 'staff', userId: req.userId }
}

// Mongo filter for a subject (the id field only — userId is only ever set on a
// staff request, and requests that predate staff leave store no subjectType).
function subjectFilter(subject) {
  return subject.subjectType === 'staff' ? { userId: subject.userId } : { tutorId: subject.tutorId }
}

// Same gate as the review route.
const canReviewLeaves = (req) =>
  req.userPermissions.has('leave.review') || req.userPermissions.has('tutor.update')

const isSuperAdmin = (req) => (req.user.roles || []).some(r => r.key === 'super_admin')

// Populate both subject refs — only one is ever set, so the unused one is null.
const withSubject = (query) => query
  .populate('tutorId', 'name tutorId')
  .populate('userId', 'displayName email employeeId')

const subjectName = (leave, fallback) =>
  leave.tutorId?.name || leave.userId?.displayName || leave.userId?.email || fallback

// The portal account behind a leave request — who hears about the decision.
async function subjectUser(leave) {
  if (leave.subjectType === 'staff') {
    return User.findOne({ _id: leave.userId?._id || leave.userId, status: 'active' }).select('_id').lean()
  }
  return User.findOne({ linkedTutorId: leave.tutorId?._id || leave.tutorId, status: 'active' }).select('_id').lean()
}

// Which requests the caller may see. Tutors and staff who can't review only ever
// see their own; reviewers see everyone's and may narrow it down.
function scopeFilter(req) {
  if (req.user.linkedTutorId || !canReviewLeaves(req)) return subjectFilter(selfSubject(req))

  const { tutorId, userId, subjectType, mine } = req.query
  if (mine === '1' || mine === 'true') return subjectFilter(selfSubject(req))

  const filter = {}
  if (tutorId) filter.tutorId = tutorId
  if (userId) filter.userId = userId
  if (subjectType === 'staff') filter.subjectType = 'staff'
  else if (subjectType === 'tutor') filter.subjectType = { $ne: 'staff' }
  return filter
}

// Who a new request is for. Only a reviewer may file on someone else's behalf;
// with no one named, the request is the caller's own.
async function resolveSubject(req) {
  const own = selfSubject(req)
  if (req.user.linkedTutorId || !canReviewLeaves(req)) return own

  const { tutorId, userId } = req.body
  if (tutorId) {
    if (!mongoose.isValidObjectId(tutorId) || !(await TutorProfile.exists({ _id: tutorId }))) return null
    return { subjectType: 'tutor', tutorId }
  }
  if (userId && String(userId) !== String(req.userId)) {
    if (!mongoose.isValidObjectId(userId)) return null
    const target = await User.findById(userId).select('linkedTutorId linkedStudentId').lean()
    if (!target || target.linkedStudentId) return null
    // A tutor picked by their login still files against their tutor profile.
    return target.linkedTutorId
      ? { subjectType: 'tutor', tutorId: target.linkedTutorId }
      : { subjectType: 'staff', userId: target._id }
  }
  return own
}

export async function listLeaves(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))

    const filter = scopeFilter(req)
    if (req.query.status) filter.status = req.query.status

    const total = await LeaveRequest.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await withSubject(LeaveRequest.find(filter))
      .populate('requestedBy', 'displayName')
      .populate('reviewedBy', 'displayName')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List leaves error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createLeave(req, res) {
  try {
    const { leaveType, startDate, endDate, reason } = req.body
    if (!leaveType || !startDate || !endDate || !reason) {
      return res.status(400).json({ error: 'leaveType, startDate, endDate, and reason are required' })
    }

    const subject = await resolveSubject(req)
    if (!subject) return res.status(400).json({ error: 'The selected tutor or staff member was not found' })

    // Check for overlapping leave requests
    const overlap = await LeaveRequest.findOne({
      ...subjectFilter(subject),
      status: { $ne: 'rejected' },
      $or: [
        { startDate: { $lte: new Date(endDate) }, endDate: { $gte: new Date(startDate) } },
      ],
    })
    if (overlap) return res.status(400).json({ error: 'An overlapping leave request already exists' })

    const leave = await LeaveRequest.create({
      ...subject,
      requestedBy: req.userId,
      leaveType, reason,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    })

    const populated = await withSubject(LeaveRequest.findById(leave._id))
      .populate('requestedBy', 'displayName')
      .lean()

    const isStaff = subject.subjectType === 'staff'
    const personName = subjectName(populated, isStaff ? 'A staff member' : 'A tutor')
    const dateRange = `${new Date(startDate).toLocaleDateString()} to ${new Date(endDate).toLocaleDateString()}`
    const notifBody = `${personName} requested ${leaveType} leave from ${dateRange}`
    const owner = await subjectUser(populated)

    // Notify admins, QCIs, principals, coordinators — not the person who filed it,
    // and not the person it is for (they get the confirmation below instead).
    const allUsers = await User.find({ status: 'active' })
      .populate('roles', 'key')
      .lean()

    const skip = new Set([String(req.userId), String(owner?._id || '')])
    const notifyUsers = allUsers.filter(u =>
      u.roles?.some(r => REVIEWER_ROLES.includes(r.key)) && !skip.has(String(u._id))
    )

    try {
      if (notifyUsers.length > 0) {
        const created = await Notification.insertMany(notifyUsers.map(u => ({
          userId: u._id,
          type: 'leave_request',
          title: 'New Leave Request',
          // tutorName is kept in the payload for existing clients; it carries a
          // staff member's name too.
          body: notifBody,
          payload: { leaveId: leave._id, tutorName: personName, subjectType: subject.subjectType, leaveType },
        })))
        // Live bell update — the client's SocketContext listens for 'notification'
        created.forEach(n => emitToUser(n.userId, 'notification', n))
      }
    } catch (e) { console.error('notify failed:', e.message) }

    // Real-time socket push to reviewer roles
    for (const role of REVIEWER_ROLES) {
      emitToRole(role, 'leave_request', { leaveId: leave._id, tutorName: personName, subjectType: subject.subjectType, leaveType, startDate, endDate })
    }

    // Also notify the person themselves when someone else filed it for them
    if (owner && owner._id.toString() !== req.userId.toString()) {
      await createNotification({
        userId: owner._id,
        type: 'leave_request',
        title: 'Leave Request Submitted',
        body: `Your ${leaveType} leave request (${dateRange}) has been submitted and is pending review.`,
        payload: { leaveId: leave._id },
      })
      emitToUser(owner._id, 'leave_request', { leaveId: leave._id, status: 'pending' })
    }

    await logActivity({
      level: 'info', category: 'leave', action: 'leave_requested',
      message: `Leave request by ${personName}: ${leaveType} (${dateRange})`,
      req,
    })

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create leave error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function reviewLeave(req, res) {
  try {
    const leave = await LeaveRequest.findById(req.params.id)
    if (!leave) return res.status(404).json({ error: 'Leave request not found' })
    if (leave.status !== 'pending') return res.status(400).json({ error: 'Leave request already reviewed' })

    const { status } = req.body
    // The portal's review form posts `notes`; `reviewNotes` is the documented name.
    const reviewNotes = String(req.body.reviewNotes ?? req.body.notes ?? '').trim()
    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or rejected' })
    }

    const isStaff = leave.subjectType === 'staff'
    // Management can now file their own leave, so a reviewer could otherwise sign
    // off on it themselves. The super admin has nobody above them to ask.
    if (isStaff && String(leave.userId) === String(req.userId) && !isSuperAdmin(req)) {
      return res.status(403).json({ error: 'You cannot review your own leave request' })
    }

    leave.status = status
    leave.reviewedBy = req.userId
    leave.reviewedAt = new Date()
    leave.reviewNotes = reviewNotes
    await leave.save()

    // If approved, mark absent for those dates in TutorAttendance (which holds
    // staff attendance too)
    if (status === 'approved') {
      const subject = isStaff
        ? { subjectType: 'staff', userId: leave.userId }
        : { subjectType: 'tutor', tutorId: leave.tutorId }
      const start = new Date(leave.startDate)
      const end = new Date(leave.endDate)
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStart = new Date(d)
        dateStart.setHours(0, 0, 0, 0)

        const existing = await TutorAttendance.findOne({ ...subjectFilter(subject), date: dateStart })
        if (!existing) {
          await TutorAttendance.create({
            ...subject,
            date: dateStart,
            status: 'absent',
            notes: `On approved ${leave.leaveType} leave`,
          })
        }
      }
    }

    const populated = await withSubject(LeaveRequest.findById(leave._id))
      .populate('reviewedBy', 'displayName')
      .lean()

    const personName = subjectName(populated, isStaff ? 'Staff member' : 'Tutor')
    const reviewerName = populated.reviewedBy?.displayName || 'Admin'
    const dateRange = `${new Date(leave.startDate).toLocaleDateString()} - ${new Date(leave.endDate).toLocaleDateString()}`
    const notifType = status === 'approved' ? 'leave_approved' : 'leave_rejected'
    const statusLabel = status === 'approved' ? 'Approved' : 'Rejected'

    // 1. Notify the person whose leave it is
    const owner = await subjectUser(leave)
    if (owner) {
      await createNotification({
        userId: owner._id,
        type: notifType,
        title: `Leave ${statusLabel}`,
        body: `Your ${leave.leaveType} leave (${dateRange}) has been ${status} by ${reviewerName}.${reviewNotes ? ' Note: ' + reviewNotes : ''}`,
        payload: { leaveId: leave._id, status },
      })
      emitToUser(owner._id, 'leave_reviewed', { leaveId: leave._id, status, reviewerName })
    }

    // 2. Notify other reviewers (admins, QCI, principal, coordinator) about the decision
    const allUsers = await User.find({ status: 'active' })
      .populate('roles', 'key')
      .lean()

    const skip = new Set([String(req.userId), String(owner?._id || '')])
    const otherReviewers = allUsers.filter(u =>
      u.roles?.some(r => REVIEWER_ROLES.includes(r.key)) && !skip.has(String(u._id))
    )

    try {
      if (otherReviewers.length > 0) {
        const created = await Notification.insertMany(otherReviewers.map(u => ({
          userId: u._id,
          type: notifType,
          title: `Leave ${statusLabel}`,
          body: `${personName}'s ${leave.leaveType} leave (${dateRange}) was ${status} by ${reviewerName}.`,
          payload: { leaveId: leave._id, tutorName: personName, status },
        })))
        // Live bell update — the client's SocketContext listens for 'notification'
        created.forEach(n => emitToUser(n.userId, 'notification', n))
      }
    } catch (e) { console.error('notify failed:', e.message) }

    // Socket push to reviewer roles
    for (const role of REVIEWER_ROLES) {
      emitToRole(role, 'leave_reviewed', { leaveId: leave._id, tutorName: personName, status, reviewerName })
    }

    await logActivity({
      level: 'info', category: 'leave', action: `leave_${status}`,
      message: `Leave ${status} by ${reviewerName}: ${personName} (${leave.leaveType}, ${dateRange})`,
      req,
    })

    res.json(populated)
  } catch (err) {
    console.error('Review leave error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getLeaveStats(req, res) {
  try {
    const filter = scopeFilter(req)

    const year = parseInt(req.query.year, 10) || new Date().getFullYear()
    filter.startDate = { $gte: new Date(year, 0, 1) }
    filter.endDate = { $lte: new Date(year, 11, 31, 23, 59, 59) }

    // aggregate() does not cast like find() does, so ids from the query string
    // have to be turned into ObjectIds by hand.
    const match = { ...filter, status: 'approved' }
    for (const key of ['tutorId', 'userId']) {
      if (match[key] && mongoose.isValidObjectId(match[key])) match[key] = new mongoose.Types.ObjectId(String(match[key]))
    }

    const [pending, approved, rejected, byType] = await Promise.all([
      LeaveRequest.countDocuments({ ...filter, status: 'pending' }),
      LeaveRequest.countDocuments({ ...filter, status: 'approved' }),
      LeaveRequest.countDocuments({ ...filter, status: 'rejected' }),
      LeaveRequest.aggregate([
        { $match: match },
        { $group: { _id: '$leaveType', count: { $sum: 1 }, totalDays: { $sum: '$totalDays' } } },
      ]),
    ])

    const totalDays = byType.reduce((sum, t) => sum + (t.totalDays || 0), 0)

    res.json({ pending, approved, rejected, totalDays, byType })
  } catch (err) {
    console.error('Leave stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
