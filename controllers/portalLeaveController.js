import LeaveRequest from '../models/LeaveRequest.js'
import TutorAttendance from '../models/TutorAttendance.js'
import Notification from '../models/Notification.js'
import User from '../models/User.js'
import { logActivity } from '../utils/activityLogger.js'
import { emitToUser, emitToRole } from '../config/socket.js'
import { createNotification } from './portalNotificationController.js'

export async function listLeaves(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { tutorId, status } = req.query

    const filter = {}

    // Scope: tutors see only their own leave requests
    if (req.user.linkedTutorId) {
      filter.tutorId = req.user.linkedTutorId
    } else {
      if (tutorId) filter.tutorId = tutorId
    }
    if (status) filter.status = status

    const total = await LeaveRequest.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await LeaveRequest.find(filter)
      .populate('tutorId', 'name tutorId')
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
    const { tutorId, leaveType, startDate, endDate, reason } = req.body
    if (!leaveType || !startDate || !endDate || !reason) {
      return res.status(400).json({ error: 'leaveType, startDate, endDate, and reason are required' })
    }

    // Determine tutorId: if user is a tutor, use their linked ID
    const resolvedTutorId = req.user.linkedTutorId || tutorId
    if (!resolvedTutorId) return res.status(400).json({ error: 'tutorId is required' })

    // Check for overlapping leave requests
    const overlap = await LeaveRequest.findOne({
      tutorId: resolvedTutorId,
      status: { $ne: 'rejected' },
      $or: [
        { startDate: { $lte: new Date(endDate) }, endDate: { $gte: new Date(startDate) } },
      ],
    })
    if (overlap) return res.status(400).json({ error: 'An overlapping leave request already exists' })

    const leave = await LeaveRequest.create({
      tutorId: resolvedTutorId,
      requestedBy: req.userId,
      leaveType, reason,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    })

    const populated = await LeaveRequest.findById(leave._id)
      .populate('tutorId', 'name tutorId')
      .populate('requestedBy', 'displayName')
      .lean()

    const tutorName = populated.tutorId?.name || 'A tutor'
    const dateRange = `${new Date(startDate).toLocaleDateString()} to ${new Date(endDate).toLocaleDateString()}`
    const notifBody = `${tutorName} requested ${leaveType} leave from ${dateRange}`

    // Notify admins, QCIs, principals, coordinators
    const allUsers = await User.find({ status: 'active' })
      .populate('roles', 'key')
      .lean()

    const reviewerRoles = ['super_admin', 'admin', 'qci', 'principal', 'coordinator']
    const notifyUsers = allUsers.filter(u =>
      u.roles?.some(r => reviewerRoles.includes(r.key)) && u._id.toString() !== req.userId.toString()
    )

    try {
      if (notifyUsers.length > 0) {
        await Notification.insertMany(notifyUsers.map(u => ({
          userId: u._id,
          type: 'leave_request',
          title: 'New Leave Request',
          body: notifBody,
          payload: { leaveId: leave._id, tutorName, leaveType },
        })))
      }
    } catch (e) { console.error('notify failed:', e.message) }

    // Real-time socket push to reviewer roles
    for (const role of reviewerRoles) {
      emitToRole(role, 'leave_request', { leaveId: leave._id, tutorName, leaveType, startDate, endDate })
    }

    // Also notify the tutor themselves (confirmation)
    const tutorUser = await User.findOne({ linkedTutorId: resolvedTutorId, status: 'active' })
    if (tutorUser && tutorUser._id.toString() !== req.userId.toString()) {
      await createNotification({
        userId: tutorUser._id,
        type: 'leave_request',
        title: 'Leave Request Submitted',
        body: `Your ${leaveType} leave request (${dateRange}) has been submitted and is pending review.`,
        payload: { leaveId: leave._id },
      })
      emitToUser(tutorUser._id, 'leave_request', { leaveId: leave._id, status: 'pending' })
    }

    await logActivity({
      level: 'info', category: 'leave', action: 'leave_requested',
      message: `Leave request by ${tutorName}: ${leaveType} (${dateRange})`,
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

    const { status, reviewNotes } = req.body
    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or rejected' })
    }

    leave.status = status
    leave.reviewedBy = req.userId
    leave.reviewedAt = new Date()
    leave.reviewNotes = reviewNotes || ''
    await leave.save()

    // If approved, mark absent for those dates in TutorAttendance
    if (status === 'approved') {
      const start = new Date(leave.startDate)
      const end = new Date(leave.endDate)
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStart = new Date(d)
        dateStart.setHours(0, 0, 0, 0)

        const existing = await TutorAttendance.findOne({ tutorId: leave.tutorId, date: dateStart })
        if (!existing) {
          await TutorAttendance.create({
            tutorId: leave.tutorId,
            date: dateStart,
            status: 'absent',
            notes: `On approved ${leave.leaveType} leave`,
          })
        }
      }
    }

    const populated = await LeaveRequest.findById(leave._id)
      .populate('tutorId', 'name tutorId')
      .populate('reviewedBy', 'displayName')
      .lean()

    const tutorName = populated.tutorId?.name || 'Tutor'
    const reviewerName = populated.reviewedBy?.displayName || 'Admin'
    const dateRange = `${new Date(leave.startDate).toLocaleDateString()} - ${new Date(leave.endDate).toLocaleDateString()}`
    const notifType = status === 'approved' ? 'leave_approved' : 'leave_rejected'
    const statusLabel = status === 'approved' ? 'Approved' : 'Rejected'

    // 1. Notify the tutor who requested the leave
    const tutorUser = await User.findOne({ linkedTutorId: leave.tutorId, status: 'active' })
    if (tutorUser) {
      await createNotification({
        userId: tutorUser._id,
        type: notifType,
        title: `Leave ${statusLabel}`,
        body: `Your ${leave.leaveType} leave (${dateRange}) has been ${status} by ${reviewerName}.${reviewNotes ? ' Note: ' + reviewNotes : ''}`,
        payload: { leaveId: leave._id, status },
      })
      emitToUser(tutorUser._id, 'leave_reviewed', { leaveId: leave._id, status, reviewerName })
    }

    // 2. Notify other reviewers (admins, QCI, principal, coordinator) about the decision
    const allUsers = await User.find({ status: 'active' })
      .populate('roles', 'key')
      .lean()

    const reviewerRoles = ['super_admin', 'admin', 'qci', 'principal', 'coordinator']
    const otherReviewers = allUsers.filter(u =>
      u.roles?.some(r => reviewerRoles.includes(r.key)) && u._id.toString() !== req.userId.toString()
    )

    try {
      if (otherReviewers.length > 0) {
        await Notification.insertMany(otherReviewers.map(u => ({
          userId: u._id,
          type: notifType,
          title: `Leave ${statusLabel}`,
          body: `${tutorName}'s ${leave.leaveType} leave (${dateRange}) was ${status} by ${reviewerName}.`,
          payload: { leaveId: leave._id, tutorName, status },
        })))
      }
    } catch (e) { console.error('notify failed:', e.message) }

    // Socket push to reviewer roles
    for (const role of reviewerRoles) {
      emitToRole(role, 'leave_reviewed', { leaveId: leave._id, tutorName, status, reviewerName })
    }

    await logActivity({
      level: 'info', category: 'leave', action: `leave_${status}`,
      message: `Leave ${status} by ${reviewerName}: ${tutorName} (${leave.leaveType}, ${dateRange})`,
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
    const filter = {}
    if (req.user.linkedTutorId) filter.tutorId = req.user.linkedTutorId
    else if (req.query.tutorId) filter.tutorId = req.query.tutorId

    const year = parseInt(req.query.year, 10) || new Date().getFullYear()
    filter.startDate = { $gte: new Date(year, 0, 1) }
    filter.endDate = { $lte: new Date(year, 11, 31, 23, 59, 59) }

    const [pending, approved, rejected, byType] = await Promise.all([
      LeaveRequest.countDocuments({ ...filter, status: 'pending' }),
      LeaveRequest.countDocuments({ ...filter, status: 'approved' }),
      LeaveRequest.countDocuments({ ...filter, status: 'rejected' }),
      LeaveRequest.aggregate([
        { $match: { ...filter, status: 'approved' } },
        { $group: { _id: '$leaveType', count: { $sum: 1 }, totalDays: { $sum: '$totalDays' } } },
      ]),
    ])

    res.json({ pending, approved, rejected, byType })
  } catch (err) {
    console.error('Leave stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
