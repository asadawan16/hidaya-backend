import DemoTrial from '../models/DemoTrial.js'
import TutorProfile from '../models/TutorProfile.js'
import { logActivity } from '../utils/activityLogger.js'

const STATUSES = ['scheduled', 'sign_up', 'failed', 'no_show', 'start_later']

// Build a display label from a tutor id (denormalized onto the record)
async function tutorLabel(id) {
  if (!id) return ''
  const t = await TutorProfile.findById(id).select('name tutorId').lean()
  if (!t) return ''
  return `${t.name}${t.tutorId ? ` (${t.tutorId})` : ''}`
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
    const { date, studentName, demoTutorId, demoTutor, code, source, referredByStudent, comment, status } = req.body
    if (!studentName || !studentName.trim()) return res.status(400).json({ error: 'Student name is required' })

    const demo = await DemoTrial.create({
      date: date ? new Date(date) : new Date(),
      studentName: studentName.trim(),
      demoTutorId: demoTutorId || undefined,
      demoTutor: demoTutorId ? await tutorLabel(demoTutorId) : (demoTutor || '').trim(),
      code: (code || '').trim(),
      source: (source || '').trim(),
      referredByStudent: referredByStudent || undefined,
      comment: (comment || '').trim(),
      status: STATUSES.includes(status) ? status : 'scheduled',
      createdBy: req.userId,
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
    const { date, studentName, demoTutorId, demoTutor, code, source, referredByStudent, comment, status } = req.body
    const update = {}
    if (date !== undefined) update.date = date ? new Date(date) : new Date()
    if (studentName !== undefined) update.studentName = studentName.trim()
    if (demoTutorId !== undefined) {
      update.demoTutorId = demoTutorId || null
      update.demoTutor = demoTutorId ? await tutorLabel(demoTutorId) : ''
    } else if (demoTutor !== undefined) {
      update.demoTutor = (demoTutor || '').trim()
    }
    if (code !== undefined) update.code = (code || '').trim()
    if (source !== undefined) update.source = (source || '').trim()
    if (referredByStudent !== undefined) update.referredByStudent = referredByStudent || null
    if (comment !== undefined) update.comment = (comment || '').trim()
    if (status !== undefined && STATUSES.includes(status)) update.status = status

    const demo = await DemoTrial.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('demoTutorId', 'name tutorId')
      .populate('referredByStudent', 'name rollNo')
    if (!demo) return res.status(404).json({ error: 'Demo trial not found' })
    res.json(demo)
  } catch (err) {
    console.error('Update demo error:', err)
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
