import TutorChangeRequest, { TUTOR_CHANGE_CONCERNS } from '../models/TutorChangeRequest.js'
import { isStudentAccount } from '../middleware/studentScope.js'
import Assignment from '../models/Assignment.js'
import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import User from '../models/User.js'
import Notification from '../models/Notification.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'
import { emitToUser, emitToRole } from '../config/socket.js'

const REVIEWER_ROLES = ['super_admin', 'admin', 'qcm']
// A family's request is a quality matter as much as a staffing one, so the QC
// inspectors hear about it too (they can read the queue; QCM/admin approve).
const FAMILY_REQUEST_ROLES = [...REVIEWER_ROLES, 'qci']

async function notifyReviewers({ type, title, body, payload, exceptUserId, roles = REVIEWER_ROLES }) {
  try {
    const users = await User.find({ status: 'active' }).populate('roles', 'key').select('_id roles').lean()
    const targets = users.filter(u =>
      u.roles?.some(r => roles.includes(r.key)) && String(u._id) !== String(exceptUserId),
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
    // A student account requests for itself and never names a tutor.
    if (isStudentAccount(req)) return await createFamilyRequest(req, res)

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

/**
 * A family's request: what is lacking, in their words. No tutor is named; the
 * reviewer chooses one at approval. The track is taken from the student's
 * current assignment when they have only one, so a parent with one class never
 * has to know what a "track" is.
 */
async function createFamilyRequest(req, res) {
  const studentId = req.user.linkedStudentId
  const reason = String(req.body.reason || '').trim()
  const concerns = (Array.isArray(req.body.concerns) ? req.body.concerns : [])
    .filter(c => TUTOR_CHANGE_CONCERNS.includes(c))
  if (!reason && concerns.length === 0) {
    return res.status(400).json({ error: 'Please tell us what is not working with the current tutor' })
  }
  if (reason.length > 3000) return res.status(400).json({ error: 'Message is too long' })

  const student = await Student.findById(studentId).select('name rollNo').lean()
  if (!student) return res.status(404).json({ error: 'Student not found' })

  const TRACKS = TutorChangeRequest.schema.path('track').enumValues
  const active = await Assignment.find({ studentId, endDate: null }).select('track tutorId').lean()
  const activeTracks = [...new Set(active.map(a => a.track).filter(t => TRACKS.includes(t)))]
  let track = TRACKS.includes(req.body.track) ? req.body.track : null
  if (!track) {
    if (activeTracks.length === 1) track = activeTracks[0]
    else if (activeTracks.length > 1) {
      return res.status(400).json({ error: 'Please choose which class this is about', tracks: activeTracks })
    }
  }
  if (!track) return res.status(400).json({ error: 'You have no current tutor on record. Please contact the office.' })

  const dup = await TutorChangeRequest.findOne({ studentId, track, status: 'pending' }).lean()
  if (dup) return res.status(400).json({ error: 'You already have a tutor-change request waiting for review' })

  const current = active.find(a => a.track === track)
  const request = await TutorChangeRequest.create({
    studentId, track,
    fromTutorId: current?.tutorId || null,
    reason, concerns,
    status: 'pending',
    source: 'student',
    requestedBy: req.userId,
    requestedByRole: 'student',
  })

  await logActivity({
    level: 'info', category: 'assignment', action: 'tutor_change_requested',
    message: `Tutor change requested by the family of ${student.rollNo || student.name} (${track})`, req,
    meta: { requestId: request._id, studentId, track },
  })

  await notifyReviewers({
    type: 'tutor_change_requested',
    title: 'Tutor change requested by a family',
    body: `${student.name}${student.rollNo ? ` (${student.rollNo})` : ''}, ${track}: ${reason ? reason.slice(0, 110) : concerns.join(', ')}`,
    payload: { requestId: request._id, studentId, track },
    exceptUserId: req.userId,
    roles: FAMILY_REQUEST_ROLES,
  })
  FAMILY_REQUEST_ROLES.forEach(role => emitToRole(role, 'tutor_change_request', { requestId: request._id }))

  res.status(201).json(shapeFamilyRequest(request.toObject()))
}

/** What a family sees back about its own request: no reviewer identities. */
function shapeFamilyRequest(r) {
  return {
    _id: r._id,
    track: r.track,
    reason: r.reason,
    concerns: r.concerns || [],
    status: r.status,
    reviewNotes: r.status === 'pending' ? '' : (r.reviewNotes || ''),
    reviewedAt: r.reviewedAt || null,
    newTutorName: r.status === 'approved' ? (r.toTutorId?.name || '') : '',
    createdAt: r.createdAt,
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
    // Students see only the requests THIS account sent, in a family-safe shape.
    // Filtering on studentId alone also returned the spreadsheet-imported history
    // (requestedByRole 'import', no requester) and staff-raised requests about the
    // student — neither is the family's "your requests".
    if (isStudentAccount(req)) {
      const own = await TutorChangeRequest.find({
        studentId: req.user.linkedStudentId,
        requestedBy: req.userId,
        requestedByRole: { $ne: 'import' },
      })
        .populate('toTutorId', 'name')
        .sort({ createdAt: -1 }).limit(30).lean()
      return res.json({ records: own.map(shapeFamilyRequest) })
    }
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

    // A family's request names no tutor; the reviewer chooses one now.
    if (req.body.toTutorId) request.toTutorId = req.body.toTutorId
    if (!request.toTutorId) return res.status(400).json({ error: 'Choose the new tutor to approve this request' })

    const student = await Student.findById(request.studentId).lean()
    const newTutor = await TutorProfile.findById(request.toTutorId).lean()
    if (!student || !newTutor) return res.status(404).json({ error: 'Student or tutor no longer exists' })
    const alreadyTheirs = await Assignment.findOne({ studentId: request.studentId, track: request.track, endDate: null, tutorId: request.toTutorId }).lean()
    if (alreadyTheirs) return res.status(400).json({ error: 'That tutor is already assigned for this track' })

    // A family's words are about the outgoing tutor: they stay on the request
    // (management-only) and are not copied onto assignment records.
    const assignmentReason = request.source === 'student'
      ? 'Tutor change requested by the family'
      : (request.reason || '')

    // Close any current active assignment for this student+track (current → past tutor)
    await Assignment.updateMany(
      { studentId: request.studentId, track: request.track, endDate: null },
      { endDate: new Date(), reason: assignmentReason ? `Tutor change: ${assignmentReason}` : 'Tutor change approved' },
    )

    // Assign the new tutor
    const assignment = await Assignment.create({
      studentId: request.studentId,
      tutorId: request.toTutorId,
      track: request.track,
      type: 'permanent',
      startDate: new Date(),
      endDate: null,
      reason: assignmentReason || 'Tutor change approved',
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
