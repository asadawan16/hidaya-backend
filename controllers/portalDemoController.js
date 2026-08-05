import DemoTrial from '../models/DemoTrial.js'
import TutorProfile from '../models/TutorProfile.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification, notifyRoles } from './portalNotificationController.js'
import { emitToStaff } from '../config/socket.js'

const STATUSES = ['scheduled', 'sign_up', 'failed', 'no_show', 'start_later']

// Build a display label from a tutor id (denormalized onto the record)
async function tutorLabel(id) {
  if (!id) return ''
  const t = await TutorProfile.findById(id).select('name tutorId').lean()
  if (!t) return ''
  return `${t.name}${t.tutorId ? ` (${t.tutorId})` : ''}`
}

// Sanitize an incoming managerIds array to a clean array of id strings.
function cleanManagerIds(v) {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map(x => String(x?._id || x)).filter(Boolean))]
}

// The user account for a demo's assigned tutor (if any).
async function tutorUserId(demoTutorId) {
  if (!demoTutorId) return null
  const u = await User.findOne({ linkedTutorId: demoTutorId, status: 'active' }).select('_id').lean()
  return u ? String(u._id) : null
}

function demoBody(demo) {
  const when = demo.date ? new Date(demo.date).toLocaleDateString('en-GB') : ''
  return `Demo for ${demo.studentName}` +
    (demo.demoTutor ? ` — Tutor: ${demo.demoTutor}` : '') +
    (demo.time ? ` at ${demo.time}` : '') +
    (when ? ` on ${when}` : '')
}

// Notify a set of tagged users (+ optionally super-admins/admins) that a demo
// was assigned. Never throws (createNotification swallows errors).
async function notifyDemoAssigned(demo, recipientIds, { includeAdmins = false } = {}) {
  const title = 'Demo Trial Assigned'
  const body = demoBody(demo)
  const payload = { demoId: demo._id, studentName: demo.studentName }
  for (const uid of recipientIds) {
    await createNotification({ userId: uid, type: 'demo_assigned', title, body, payload })
  }
  if (includeAdmins) {
    await notifyRoles(['super_admin', 'admin'], { type: 'demo_assigned', title, body, payload })
  }
}

// ─── List demo trials with stats ───
export async function listDemos(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { status, source, search, sort } = req.query

    const filter = {}
    if (status) filter.status = status
    if (source) filter.source = source
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ studentName: regex }, { demoTutor: regex }, { code: regex }]
    }

    const total = await DemoTrial.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    let sortObj = { date: -1, createdAt: -1 }
    if (sort === 'name') sortObj = { studentName: 1 }
    if (sort === 'status') sortObj = { status: 1, date: -1 }

    const records = await DemoTrial.find(filter)
      .populate('demoTutorId', 'name tutorId')
      .populate('referredByStudent', 'name rollNo')
      .populate('managerIds', 'displayName email')
      .sort(sortObj)
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    const statusAgg = await DemoTrial.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    const statusCounts = Object.fromEntries(STATUSES.map(s => [s, 0]))
    statusAgg.forEach(s => { if (s._id) statusCounts[s._id] = s.count })

    const sourceAgg = await DemoTrial.aggregate([{ $match: { source: { $ne: '' } } }, { $group: { _id: '$source', count: { $sum: 1 } } }])
    const sourceCounts = {}
    sourceAgg.forEach(s => { if (s._id) sourceCounts[s._id] = s.count })

    res.json({ records, total, page: safePage, pages, statusCounts, sourceCounts })
  } catch (err) {
    console.error('List demos error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Stats (totals like the sheet) ───
export async function getDemoStats(req, res) {
  try {
    const total = await DemoTrial.countDocuments()
    const statusAgg = await DemoTrial.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    const statusCounts = Object.fromEntries(STATUSES.map(s => [s, 0]))
    statusAgg.forEach(s => { if (s._id) statusCounts[s._id] = s.count })
    const sourceAgg = await DemoTrial.aggregate([{ $match: { source: { $ne: '' } } }, { $group: { _id: '$source', count: { $sum: 1 } } }])
    const sourceCounts = {}
    sourceAgg.forEach(s => { if (s._id) sourceCounts[s._id] = s.count })
    res.json({ total, statusCounts, sourceCounts })
  } catch (err) {
    console.error('Demo stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Create ───
export async function createDemo(req, res) {
  try {
    const { date, time, studentName, demoTutorId, demoTutor, managerIds, code, source, referredByStudent, comment, status } = req.body
    if (!studentName || !studentName.trim()) return res.status(400).json({ error: 'Student name is required' })

    const managers = cleanManagerIds(managerIds)
    const demo = await DemoTrial.create({
      date: date ? new Date(date) : new Date(),
      time: (time || '').trim(),
      studentName: studentName.trim(),
      demoTutorId: demoTutorId || undefined,
      demoTutor: demoTutorId ? await tutorLabel(demoTutorId) : (demoTutor || '').trim(),
      managerIds: managers,
      code: (code || '').trim(),
      source: (source || '').trim(),
      referredByStudent: referredByStudent || undefined,
      comment: (comment || '').trim(),
      status: STATUSES.includes(status) ? status : 'scheduled',
      createdBy: req.userId,
    })

    // Notify the assigned tutor + tagged managers + admins, then fire the
    // portal-wide blocking announcement popup (all staff, ack tracked on the demo).
    const recipients = new Set(managers)
    const tUid = await tutorUserId(demo.demoTutorId)
    if (tUid) recipients.add(tUid)
    await notifyDemoAssigned(demo, [...recipients], { includeAdmins: true })
    // staff-only: students must not receive demo-trial announcements
    emitToStaff('demo_announced', {
      demoId: demo._id, studentName: demo.studentName,
      tutorLabel: demo.demoTutor, date: demo.date, time: demo.time,
    })

    await logActivity({
      category: 'demo', action: 'create', req,
      message: `Demo trial created for ${demo.studentName}`,
    })
    res.status(201).json(demo)
  } catch (err) {
    console.error('Create demo error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Update (full edit) ───
export async function updateDemo(req, res) {
  try {
    const existing = await DemoTrial.findById(req.params.id).lean()
    if (!existing) return res.status(404).json({ error: 'Demo trial not found' })

    const { date, time, studentName, demoTutorId, demoTutor, managerIds, code, source, referredByStudent, comment, status } = req.body
    const update = {}
    if (date !== undefined) update.date = date ? new Date(date) : new Date()
    if (time !== undefined) update.time = (time || '').trim()
    if (studentName !== undefined) update.studentName = studentName.trim()
    if (demoTutorId !== undefined) {
      update.demoTutorId = demoTutorId || null
      update.demoTutor = demoTutorId ? await tutorLabel(demoTutorId) : ''
    } else if (demoTutor !== undefined) {
      update.demoTutor = (demoTutor || '').trim()
    }
    if (managerIds !== undefined) update.managerIds = cleanManagerIds(managerIds)
    if (code !== undefined) update.code = (code || '').trim()
    if (source !== undefined) update.source = (source || '').trim()
    if (referredByStudent !== undefined) update.referredByStudent = referredByStudent || null
    if (comment !== undefined) update.comment = (comment || '').trim()
    if (status !== undefined && STATUSES.includes(status)) update.status = status

    const demo = await DemoTrial.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('demoTutorId', 'name tutorId')
      .populate('referredByStudent', 'name rollNo')

    // Notify anyone newly tagged (added managers or a newly-assigned tutor) —
    // no broadcast popup on edits, only on create.
    const oldManagers = new Set((existing.managerIds || []).map(String))
    const added = new Set((demo.managerIds || []).map(String).filter(id => !oldManagers.has(id)))
    if (update.demoTutorId !== undefined && String(update.demoTutorId) !== String(existing.demoTutorId || '')) {
      const tUid = await tutorUserId(demo.demoTutorId)
      if (tUid) added.add(tUid)
    }
    if (added.size) await notifyDemoAssigned(demo, [...added])

    res.json(demo)
  } catch (err) {
    console.error('Update demo error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Announcement popup (blocking, all staff) ───

// GET /portal/demos/pending-announcement — recent demos the caller hasn't acked.
export async function pendingAnnouncement(req, res) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const demos = await DemoTrial.find({
      status: 'scheduled',
      createdAt: { $gte: since },
      announceAckBy: { $ne: req.userId },
    })
      .select('studentName demoTutor date time createdAt')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean()
    res.json(demos)
  } catch (err) {
    console.error('Demo pending announcement error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/demos/:id/ack — mark the announcement acknowledged for this user.
export async function ackAnnouncement(req, res) {
  try {
    await DemoTrial.findByIdAndUpdate(req.params.id, { $addToSet: { announceAckBy: req.userId } })
    res.json({ ok: true })
  } catch (err) {
    console.error('Demo ack error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Update status only ───
export async function updateDemoStatus(req, res) {
  try {
    const { status } = req.body
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })
    const demo = await DemoTrial.findByIdAndUpdate(req.params.id, { status }, { new: true })
    if (!demo) return res.status(404).json({ error: 'Demo trial not found' })
    res.json(demo)
  } catch (err) {
    console.error('Update demo status error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/demos/managers — management users to tag as demo overseers.
// Gated by demo.manage (not user.read) so principals/coordinators can assign.
export async function pickerDemoManagers(req, res) {
  try {
    const lim = Math.max(1, Math.min(30, parseInt(req.query.limit, 10) || 20))
    const { q, ids } = req.query

    const filter = { status: 'active' }
    if (ids) {
      filter._id = { $in: String(ids).split(',').map(s => s.trim()).filter(Boolean).slice(0, 50) }
    } else {
      const mgmtRoles = await Role.find({ key: { $nin: ['tutor', 'super_admin', 'student'] } }).select('_id').lean()
      filter.roles = { $in: mgmtRoles.map(r => r._id) }
      if (q) {
        const regex = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        filter.$or = [{ displayName: regex }, { email: regex }]
      }
    }

    const records = await User.find(filter)
      .select('displayName email status')
      .sort({ displayName: 1 })
      .limit(ids ? 50 : lim)
      .lean()
    res.json(records)
  } catch (err) {
    console.error('Demo managers picker error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Delete ───
export async function deleteDemo(req, res) {
  try {
    const demo = await DemoTrial.findByIdAndDelete(req.params.id)
    if (!demo) return res.status(404).json({ error: 'Demo trial not found' })
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete demo error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
