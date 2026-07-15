import TutorChangeRequest from '../models/TutorChangeRequest.js'
import Assignment from '../models/Assignment.js'
import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import User from '../models/User.js'
import Notification from '../models/Notification.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'
import { emitToUser, emitToRole } from '../config/socket.js'

const REVIEWER_ROLES = ['super_admin', 'admin', 'qcm']

async function notifyReviewers({ type, title, body, payload, exceptUserId }) {
  try {
    const users = await User.find({ status: 'active' }).populate('roles', 'key').select('_id roles').lean()
    const targets = users.filter(u =>
      u.roles?.some(r => REVIEWER_ROLES.includes(r.key)) && String(u._id) !== String(exceptUserId),
    )
    if (targets.length) {
      const created = await Notification.insertMany(targets.map(u => ({ userId: u._id, type, title, body, payload })))
      created.forEach(n => emitToUser(n.userId, 'notification', n))
    }
  } catch (e) { console.error('notify reviewers failed:', e.message) }
}

const primaryRole = (req) => req.user?.roles?.[0]?.key || ''

// ─── Create a tutor-change request (QCI or student) ───
export async function createTutorChangeRequest(req, res) {
  try {
    let { studentId, track, toTutorId, reason } = req.body

    // Students may only request for themselves.
    if (req.user.linkedStudentId) {
      studentId = req.user.linkedStudentId
    }
    if (!studentId || !track || !toTutorId) {
      return res.status(400).json({ error: 'studentId, track, and toTutorId (new tutor) are required' })
    }

    const student = await Student.findById(studentId).lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })
    const newTutor = await TutorProfile.findById(toTutorId).lean()
    if (!newTutor) return res.status(404).json({ error: 'Selected new tutor not found' })

    // Current active tutor for this track (if any)
    const current = await Assignment.findOne({ studentId, track, endDate: null }).lean()
    if (current && String(current.tutorId) === String(toTutorId)) {
      return res.status(400).json({ error: 'The selected tutor is already assigned for this track' })
    }

    // Prevent duplicate pending requests for the same student+track
    const dup = await TutorChangeRequest.findOne({ studentId, track, status: 'pending' }).lean()
    if (dup) return res.status(400).json({ error: 'A pending tutor-change request already exists for this track' })

    const request = await TutorChangeRequest.create({
      studentId, track,
      fromTutorId: current?.tutorId || null,
      toTutorId,
      reason: reason || '',
      status: 'pending',
      requestedBy: req.userId,
      requestedByRole: primaryRole(req),
    })

    await logActivity({
      level: 'info', category: 'assignment', action: 'tutor_change_requested',
      message: `Tutor change requested for ${student.rollNo} (${track})`, req,
      meta: { requestId: request._id, studentId, track },
    })

    const populated = await TutorChangeRequest.findById(request._id)
      .populate('studentId', 'name rollNo')
      .populate('fromTutorId', 'name tutorId')
      .populate('toTutorId', 'name tutorId')
      .lean()

    await notifyReviewers({
      type: 'tutor_change_requested',
      title: 'Tutor Change Requested',
      body: `${student.name} — change ${track} tutor to ${newTutor.name}.`,
      payload: { requestId: request._id, studentId, track },
      exceptUserId: req.userId,
    })
    REVIEWER_ROLES.forEach(role => emitToRole(role, 'tutor_change_request', { requestId: request._id }))

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create tutor change request error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── List requests (queue) ───
export async function listTutorChangeRequests(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { status, studentId } = req.query

    const filter = {}
    if (status) filter.status = status
    if (studentId) filter.studentId = studentId
    // Students see only their own requests.
    if (req.user.linkedStudentId) filter.studentId = req.user.linkedStudentId

    const total = await TutorChangeRequest.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await TutorChangeRequest.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('fromTutorId', 'name tutorId')
      .populate('toTutorId', 'name tutorId')
      .populate('requestedBy', 'displayName')
      .populate('reviewedBy', 'displayName')
      .sort({ status: 1, createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    // Global counts per status (ignore the status filter, keep the student scope)
    // so the overview cards are accurate across all pages.
    const statsFilter = { ...filter }
    delete statsFilter.status
    const statsAgg = await TutorChangeRequest.aggregate([
      ...(Object.keys(statsFilter).length ? [{ $match: statsFilter }] : []),
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    const statusStats = { pending: 0, approved: 0, rejected: 0 }
    for (const s of statsAgg) if (statusStats[s._id] !== undefined) statusStats[s._id] = s.count

    res.json({ records, total, page: safePage, pages, statusStats })
  } catch (err) {
    console.error('List tutor change requests error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Approve — close current tutor (→ past), assign new tutor ───
export async function approveTutorChangeRequest(req, res) {
  try {
    const request = await TutorChangeRequest.findById(req.params.id)
    if (!request) return res.status(404).json({ error: 'Request not found' })
    if (request.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be approved' })

    const student = await Student.findById(request.studentId).lean()
    const newTutor = await TutorProfile.findById(request.toTutorId).lean()
    if (!student || !newTutor) return res.status(404).json({ error: 'Student or tutor no longer exists' })

    // Close any current active assignment for this student+track (current → past tutor)
    await Assignment.updateMany(
      { studentId: request.studentId, track: request.track, endDate: null },
      { endDate: new Date(), reason: request.reason ? `Tutor change: ${request.reason}` : 'Tutor change approved' },
    )

    // Assign the new tutor
    const assignment = await Assignment.create({
      studentId: request.studentId,
      tutorId: request.toTutorId,
      track: request.track,
      type: 'permanent',
      startDate: new Date(),
      endDate: null,
      reason: request.reason || 'Tutor change approved',
      assignedBy: req.userId,
      approvalStatus: 'approved',
    })

    request.status = 'approved'
    request.reviewedBy = req.userId
    request.reviewedAt = new Date()
    request.reviewNotes = req.body.reviewNotes || ''
    request.resultingAssignmentId = assignment._id
    await request.save()

    await logActivity({
      level: 'info', category: 'assignment', action: 'tutor_change_approved',
      message: `Tutor change approved for ${student.rollNo} (${request.track}) → ${newTutor.tutorId}`, req,
      meta: { requestId: request._id, assignmentId: assignment._id },
    })

    // Notify: new tutor, student, requester
    const notify = async (userId, title, body) => {
      if (!userId) return
      const n = await createNotification({ userId, type: 'tutor_change_approved', title, body, payload: { requestId: request._id } })
      if (n) emitToUser(userId, 'tutor_change_reviewed', { requestId: request._id, status: 'approved' })
    }
    const newTutorUser = await User.findOne({ linkedTutorId: request.toTutorId, status: 'active' }).select('_id').lean()
    await notify(newTutorUser?._id, 'New Student Assigned', `${student.name} has been assigned to you for ${request.track}.`)
    if (student.userId) await notify(student.userId, 'Tutor Changed', `${newTutor.name} is now your tutor for ${request.track}.`)
    if (String(request.requestedBy) !== String(req.userId)) {
      await notify(request.requestedBy, 'Tutor Change Approved', `Your tutor-change request for ${student.name} (${request.track}) was approved.`)
    }

    const populated = await TutorChangeRequest.findById(request._id)
      .populate('studentId', 'name rollNo')
      .populate('fromTutorId', 'name tutorId')
      .populate('toTutorId', 'name tutorId')
      .lean()

    res.json(populated)
  } catch (err) {
    console.error('Approve tutor change request error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Reject ───
export async function rejectTutorChangeRequest(req, res) {
  try {
    const request = await TutorChangeRequest.findById(req.params.id)
    if (!request) return res.status(404).json({ error: 'Request not found' })
    if (request.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be rejected' })

    request.status = 'rejected'
    request.reviewedBy = req.userId
    request.reviewedAt = new Date()
    request.reviewNotes = req.body.reviewNotes || ''
    await request.save()

    await logActivity({
      level: 'info', category: 'assignment', action: 'tutor_change_rejected',
      message: `Tutor change rejected (${request._id})`, req, meta: { requestId: request._id },
    })

    if (String(request.requestedBy) !== String(req.userId)) {
      const n = await createNotification({
        userId: request.requestedBy, type: 'tutor_change_rejected', title: 'Tutor Change Rejected',
        body: `Your tutor-change request was rejected.${request.reviewNotes ? ' Note: ' + request.reviewNotes : ''}`,
        payload: { requestId: request._id },
      })
      if (n) emitToUser(request.requestedBy, 'tutor_change_reviewed', { requestId: request._id, status: 'rejected' })
    }

    const populated = await TutorChangeRequest.findById(request._id)
      .populate('studentId', 'name rollNo')
      .populate('toTutorId', 'name tutorId')
      .lean()

    res.json(populated)
  } catch (err) {
    console.error('Reject tutor change request error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
