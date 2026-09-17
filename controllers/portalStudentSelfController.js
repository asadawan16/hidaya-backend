/**
 * The student's own record — the endpoints a *student* account calls about
 * itself.
 *
 * Everything else in `portalStudentController.js` is gated by `student.read` /
 * `student.update`, which the student role does not hold and must not: those
 * routes serve the whole directory. The authorization here is the account's own
 * `linkedStudentId`, the same shape as `GET /portal/fees/my` — there is no id to
 * pass, so there is nothing to tamper with.
 *
 * This exists because the mobile app has two needs the portal never had. A
 * student is in Toronto or Birmingham and every class time in the app was
 * printed in Karachi wall-clock with no way to say otherwise; and a parent
 * wants to raise a complaint from the phone, which previously required a staff
 * member to type it into the portal on their behalf.
 */
import Student from '../models/Student.js'
import Complaint from '../models/Complaint.js'
import Notification from '../models/Notification.js'
import User from '../models/User.js'
import { emitToUser, emitToRole } from '../config/socket.js'
import { logActivity } from '../utils/activityLogger.js'

/** Roles that triage complaints — mirrors REVIEWER_ROLES in the tutor-change flow. */
const COMPLAINT_ROLES = ['super_admin', 'admin', 'qcm']

/**
 * The subset of a Student a student may see about themselves.
 *
 * An allow-list, not an exclusion list. The record carries staff-authored
 * material — admin notes, quality feedback, status history, guardians' contact
 * details, referral chains — and a student asking "what timezone am I in?" must
 * not receive any of it. New fields on the model therefore stay invisible here
 * until someone deliberately adds them.
 */
function publicStudentShape(s) {
  return {
    _id: s._id,
    name: s.name,
    rollNo: s.rollNo || '',
    status: s.status,
    country: s.country || '',
    timezone: s.timezone || 'Asia/Karachi',
    courseLabels: s.courseLabels || [],
    joiningDate: s.joiningDate || s.createdAt || null,
    billing: {
      fee: s.billing?.fee || 0,
      currency: s.billing?.currency || 'PKR',
      cycle: s.billing?.cycle || 'monthly',
    },
  }
}

function requireLinkedStudent(req, res) {
  if (!req.user?.linkedStudentId) {
    res.status(403).json({ error: 'Your account is not linked to a student record' })
    return null
  }
  return req.user.linkedStudentId
}

// GET /portal/students/me
export async function getMyStudent(req, res) {
  try {
    const id = requireLinkedStudent(req, res)
    if (!id) return

    const student = await Student.findById(id)
      .select('name rollNo status country timezone courseLabels joiningDate createdAt billing')
      .lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    res.json(publicStudentShape(student))
  } catch (err) {
    console.error('Get my student error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/**
 * PATCH /portal/students/me — the student's own preferences.
 *
 * Only `timezone`, and only a zone the platform's own `Intl` recognises. A
 * student editing their own Student document is a new capability, so the
 * whitelist is the point: anything not named here is ignored rather than
 * rejected, so a future client sending extra fields cannot accidentally widen
 * what a student can write.
 */
export async function updateMyStudent(req, res) {
  try {
    const id = requireLinkedStudent(req, res)
    if (!id) return

    const { timezone } = req.body || {}
    if (typeof timezone !== 'string' || !timezone.trim()) {
      return res.status(400).json({ error: 'timezone is required' })
    }
    const tz = timezone.trim()

    // Validate against the runtime's own zone database rather than a hardcoded
    // list, which would rot as zones are renamed. An invalid zone throws here.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date())
    } catch {
      return res.status(400).json({ error: `Unknown timezone: ${tz}` })
    }

    const student = await Student.findByIdAndUpdate(
      id,
      { $set: { timezone: tz } },
      { new: true, runValidators: true },
    )
      .select('name rollNo status country timezone courseLabels joiningDate createdAt billing')
      .lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    await logActivity({
      level: 'info',
      category: 'student',
      action: 'student_timezone_updated',
      message: `${student.rollNo || student.name} set their timezone to ${tz}`,
      req,
      meta: { studentId: id, timezone: tz },
    })

    res.json(publicStudentShape(student))
  } catch (err) {
    console.error('Update my student error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/**
 * POST /portal/students/me/complaints — a complaint raised from the app.
 *
 * Shaped so it lands in the *existing* admin queue rather than in a parallel
 * inbox nobody watches: it is an ordinary `Complaint`, so `GET /portal/notices/
 * complaints` and the portal's triage page pick it up with no changes.
 *
 * Three fields are set by the server, not the client:
 *  - `studentId` — the caller's own, never a parameter.
 *  - `representative: 'admin'` — the model requires which staff group owns the
 *    complaint, and one that arrives unsolicited is the admin desk's until a
 *    human routes it.
 *  - `visibility: 'management_only'` — a family complaining about a tutor must
 *    not be readable by that tutor before management has seen it. The portal
 *    already enforces this level in `listComplaints`.
 */
export async function createMyComplaint(req, res) {
  try {
    const id = requireLinkedStudent(req, res)
    if (!id) return

    const { text, complainant, category, priority } = req.body || {}
    const body = String(text || '').trim()
    if (!body) return res.status(400).json({ error: 'Please describe the problem' })
    if (body.length > 4000) return res.status(400).json({ error: 'Message is too long' })

    const student = await Student.findById(id).select('name rollNo').lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const ALLOWED_COMPLAINANTS = ['father', 'mother', 'student', 'grandfather', 'grandmother', 'uncle', 'aunty', 'brother', 'sister', 'other']
    const ALLOWED_CATEGORIES = ['parent_complaint', 'quality_issue', 'behavior', 'attendance', 'general']
    const ALLOWED_PRIORITIES = ['low', 'medium', 'high']

    const complaint = await Complaint.create({
      studentId: id,
      text: body,
      complainant: ALLOWED_COMPLAINANTS.includes(complainant) ? complainant : 'student',
      category: ALLOWED_CATEGORIES.includes(category) ? category : 'parent_complaint',
      // `urgent` is deliberately not offered to the app: a self-service urgent
      // flag becomes the default choice and stops meaning anything.
      priority: ALLOWED_PRIORITIES.includes(priority) ? priority : 'medium',
      representative: 'admin',
      visibility: 'management_only',
      status: 'open',
      source: 'student_app',
      createdBy: req.userId,
    })

    await notifyComplaintDesk({
      title: 'Complaint from a family',
      body: `${student.name}${student.rollNo ? ` (${student.rollNo})` : ''}: ${body.slice(0, 120)}${body.length > 120 ? '…' : ''}`,
      payload: { complaintId: complaint._id, studentId: id },
    })

    await logActivity({
      level: 'warning',
      category: 'complaint',
      action: 'complaint_created',
      message: `Complaint submitted from the student app for ${student.rollNo || student.name}`,
      req,
      meta: { complaintId: complaint._id, studentId: id },
    })

    res.status(201).json(shapeOwnComplaint(complaint.toObject()))
  } catch (err) {
    console.error('Create my complaint error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/**
 * GET /portal/students/me/complaints — what this family has raised, and where
 * it got to.
 *
 * Only complaints the app itself submitted. Staff-authored complaints *about*
 * this student live in the same collection and are not the family's to read —
 * which is why the filter is on `source`, not on `studentId` alone.
 */
export async function listMyComplaints(req, res) {
  try {
    const id = requireLinkedStudent(req, res)
    if (!id) return

    const rows = await Complaint.find({ studentId: id, source: 'student_app' })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()

    res.json({ records: rows.map(shapeOwnComplaint) })
  } catch (err) {
    console.error('List my complaints error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/** What the family may see back: their own words, and the outcome. */
function shapeOwnComplaint(c) {
  return {
    _id: c._id,
    text: c.text,
    complainant: c.complainant,
    category: c.category,
    priority: c.priority,
    status: c.status,
    // The resolution note is written for the family; the internal
    // `actionRequired` and `againstTutorId` fields are not exposed.
    resolution: c.status === 'open' ? '' : c.resolution || '',
    resolvedAt: c.resolvedAt || null,
    createdAt: c.createdAt,
  }
}

async function notifyComplaintDesk({ title, body, payload }) {
  try {
    const users = await User.find({ status: 'active' })
      .populate('roles', 'key')
      .select('_id roles')
      .lean()
    const targets = users.filter(u => u.roles?.some(r => COMPLAINT_ROLES.includes(r.key)))
    if (targets.length) {
      const created = await Notification.insertMany(
        targets.map(u => ({ userId: u._id, type: 'complaint', title, body, payload })),
      )
      created.forEach(n => emitToUser(n.userId, 'notification', n))
    }
    // Staff-only socket event — students never bind it (see the mobile app's
    // STUDENT_EVENTS whitelist).
    COMPLAINT_ROLES.forEach(role => emitToRole(role, 'complaint_filed', payload))
  } catch (e) {
    console.error('notify complaint desk failed:', e.message)
  }
}
