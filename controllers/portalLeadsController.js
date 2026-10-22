import crypto from 'crypto'
import Enrollment, { LEAD_STATUSES } from '../models/Enrollment.js'
import Student from '../models/Student.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
import StudentStatusHistory from '../models/StudentStatusHistory.js'
import { sendToUser } from '../services/mailer.js'
import { logActivity } from '../utils/activityLogger.js'

// Generate a secure temporary password
function generateTempPassword() {
  return crypto.randomBytes(4).toString('hex') + crypto.randomInt(10, 99)
}

// Generate next roll number
async function generateRollNo() {
  const last = await Student.findOne({ rollNo: { $regex: /^MFC\d+$/ } })
    .sort({ rollNo: -1 }).select('rollNo').lean()
  if (!last) return 'MFC01'
  const num = parseInt(last.rollNo.replace('MFC', ''), 10) + 1
  return `MFC${String(num).padStart(2, '0')}`
}

// Statuses that end the pipeline: a scheduled callback no longer applies.
const TERMINAL_STATUSES = ['enrolled', 'closed']

// Structured demo-request fields (public free-demo form / Add Lead).
// [field, maxlength] — values are human labels from demoOptions.js.
const DEMO_FIELDS = [
  ['subject', 120], ['grade', 120], ['curriculum', 120],
  ['quranCourse', 120], ['quranLevel', 120], ['ageGroup', 120],
  ['preferredTime', 120], ['tutorPreference', 120], ['studentCount', 120],
]
const PROGRAMS = ['academic', 'quran', 'both']

function pickDemoFields(body = {}) {
  const out = {}
  const program = typeof body.program === 'string' ? body.program.trim() : ''
  out.program = PROGRAMS.includes(program) ? program : ''
  for (const [key, max] of DEMO_FIELDS) {
    const v = body[key]
    out[key] = typeof v === 'string' ? v.trim().slice(0, max) : ''
  }
  return out
}

function parseDate(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// The latest call-log entry, flattened for list rows (the full log stays on getLead)
function withLastNote(lead) {
  const { callLog, ...rest } = lead
  const last = Array.isArray(callLog) && callLog.length ? callLog[callLog.length - 1] : null
  rest.lastNote = last ? { note: last.note, at: last.at, byName: last.byName || '' } : null
  return rest
}

// ─── List leads (enrollments) with stats ───
export async function listLeads(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const {
      status, search, source, sort,
      program, grade, subject, quranCourse,
      callbackFrom, callbackTo, scheduled,
    } = req.query

    const filter = {}
    if (status) filter.status = status
    if (source) filter.source = source
    // 'academic' / 'quran' also match leads that asked for both
    if (program === 'academic' || program === 'quran') filter.program = { $in: [program, 'both'] }
    else if (program === 'both') filter.program = 'both'
    // Plain strings only: `?grade[$ne]=` must not become an operator
    if (typeof grade === 'string' && grade) filter.grade = grade
    if (typeof subject === 'string' && subject) filter.subject = subject
    if (typeof quranCourse === 'string' && quranCourse) filter.quranCourse = quranCourse
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: regex }, { email: regex }, { phone: regex }]
    }

    // Callback filters: a range on nextCallbackAt and/or "anything scheduled"
    const from = parseDate(callbackFrom)
    const to = parseDate(callbackTo)
    const callbackFilter = !!(from || to || scheduled === '1' || scheduled === 'true')
    if (callbackFilter) {
      filter.nextCallbackAt = { $exists: true, $ne: null }
      if (from) filter.nextCallbackAt.$gte = from
      if (to) filter.nextCallbackAt.$lte = to
      // A finished lead with a stale callback isn't a call to make
      if (!status) filter.status = { $nin: TERMINAL_STATUSES }
    }

    const total = await Enrollment.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    let sortObj = { createdAt: -1 }
    if (sort === 'name') sortObj = { name: 1 }
    if (sort === 'status') sortObj = { status: 1, createdAt: -1 }
    if (callbackFilter) sortObj = { nextCallbackAt: 1, _id: 1 }

    const rows = await Enrollment.find(filter)
      // Only the latest call-log entry, to keep list payloads small
      .select({ callLog: { $slice: -1 } })
      .populate('referredByStudent', 'name rollNo')
      .sort(sortObj)
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()
    const records = rows.map(withLastNote)

    // Stats
    const stats = await Enrollment.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    const statusCounts = Object.fromEntries(LEAD_STATUSES.map(st => [st, 0]))
    stats.forEach(st => { statusCounts[st._id] = st.count })

    const sourceStats = await Enrollment.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ])

    res.json({ records, total, page: safePage, pages, statusCounts, sourceStats })
  } catch (err) {
    console.error('List leads error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Create lead manually (portal) ───
export async function createLead(req, res) {
  try {
    const { name, email, phone, message, source, status, referralSource, referredByStudent } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' })
    if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' })
    if (status && !LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })

    const lead = await Enrollment.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone?.trim() || '',
      message: message?.trim() || '',
      source: source || 'manual',
      status: status || 'new',
      referralSource: referralSource?.trim() || '',
      referredByStudent: referredByStudent || undefined,
      ...pickDemoFields(req.body),
    })

    await logActivity({
      level: 'info', category: 'leads', action: 'lead_created',
      message: `Lead ${lead.name} added manually`, req,
      meta: { leadId: lead._id },
    })

    res.status(201).json(lead)
  } catch (err) {
    console.error('Create lead error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Get single lead ───
export async function getLead(req, res) {
  try {
    const lead = await Enrollment.findById(req.params.id)
      .populate('referredByStudent', 'name rollNo')
      .lean()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    res.json(lead)
  } catch (err) {
    console.error('Get lead error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Update lead status ───
export async function updateLeadStatus(req, res) {
  try {
    const lead = await Enrollment.findById(req.params.id)
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    const { status } = req.body
    if (status && !LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })
    if (status) lead.status = status
    // Enrolled / closed: any scheduled callback is moot
    if (TERMINAL_STATUSES.includes(lead.status)) lead.nextCallbackAt = undefined
    await lead.save()

    await logActivity({
      level: 'info', category: 'leads', action: 'lead_status_updated',
      message: `Lead ${lead.name} status → ${status}`, req,
    })

    res.json(lead)
  } catch (err) {
    console.error('Update lead error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Add a call-log entry (and schedule / clear a callback) ───
// Body: { note, outcome?, nextCallbackAt?, status?, clearCallback? }
export async function addLeadLog(req, res) {
  try {
    const lead = await Enrollment.findById(req.params.id)
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    const { note, outcome, nextCallbackAt, status, clearCallback } = req.body || {}
    const text = typeof note === 'string' ? note.trim() : ''
    if (!text) return res.status(400).json({ error: 'A note is required' })
    if (text.length > 2000) return res.status(400).json({ error: 'Note is too long (2000 characters max)' })
    if (status && !LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })

    const callbackAt = parseDate(nextCallbackAt)
    if (nextCallbackAt && !callbackAt) return res.status(400).json({ error: 'Invalid callback date' })

    const prevStatus = lead.status
    let nextStatus = status || null

    if (callbackAt) {
      lead.nextCallbackAt = callbackAt
      if (!nextStatus && !TERMINAL_STATUSES.includes(lead.status)) nextStatus = 'callback'
    } else if (clearCallback) {
      lead.nextCallbackAt = undefined
    }

    if (nextStatus) {
      lead.status = nextStatus
      if (TERMINAL_STATUSES.includes(nextStatus)) lead.nextCallbackAt = undefined
    }

    // The callback this entry actually scheduled (none if a terminal status dropped it)
    const scheduledAt = callbackAt && lead.nextCallbackAt ? callbackAt : undefined
    lead.callLog.push({
      note: text,
      outcome: typeof outcome === 'string' ? outcome.trim().slice(0, 120) : '',
      nextCallbackAt: scheduledAt,
      statusAfter: lead.status !== prevStatus ? lead.status : '',
      by: req.userId,
      byName: req.user?.displayName || req.user?.email || '',
      at: new Date(),
    })
    await lead.save()

    await logActivity({
      level: 'info', category: 'leads', action: 'lead_call_logged',
      message: `Call logged on lead ${lead.name}`
        + (lead.status !== prevStatus ? ` (status → ${lead.status})` : '')
        + (scheduledAt ? `, callback ${scheduledAt.toISOString()}` : ''),
      req,
      meta: { leadId: lead._id },
    })

    await lead.populate('referredByStudent', 'name rollNo')
    res.json(lead.toObject())
  } catch (err) {
    console.error('Add lead log error:', err)
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Convert lead to student ───
export async function convertToStudent(req, res) {
  try {
    const lead = await Enrollment.findById(req.params.id)
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    if (lead.status === 'enrolled') return res.status(400).json({ error: 'Lead is already enrolled' })

    const {
      displayName, courseLabels, placementLevel, sect,
      country, timezone, whatsappNumber, billing, notes, familyId,
    } = req.body

    // Check if user with this email already exists
    const existingUser = await User.findOne({ email: lead.email.toLowerCase().trim() })
    if (existingUser) {
      return res.status(400).json({ error: 'A user with this email already exists' })
    }

    // Get student role
    const studentRole = await Role.findOne({ key: 'student' })
    if (!studentRole) return res.status(400).json({ error: 'Student role not found. Please seed roles.' })

    // Generate temp password
    const tempPassword = generateTempPassword()

    // Create user account
    const user = await User.create({
      email: lead.email.toLowerCase().trim(),
      password: tempPassword,
      displayName: (displayName || lead.name).trim(),
      phone: lead.phone?.trim() || '',
      roles: [studentRole._id],
      status: 'active',
    })

    // Generate roll number
    const rollNo = await generateRollNo()

    // Create student record
    const studentData = {
      rollNo,
      name: (displayName || lead.name).trim(),
      email: lead.email.toLowerCase().trim(),
      phone: lead.phone?.trim() || '',
      courseLabels: courseLabels || [],
      placementLevel: placementLevel || '',
      sect: sect || '',
      country: country || '',
      timezone: timezone || 'Asia/Karachi',
      whatsappNumber: whatsappNumber || lead.phone || '',
      billing: billing || {},
      notes: notes || lead.message || '',
      status: 'active',
      userId: user._id,
      referredBy: lead.referralSource || '',
      referredByStudent: lead.referredByStudent || undefined,
    }

    if (familyId) {
      studentData.familyId = familyId
    }

    const student = await Student.create(studentData)

    // If family is linked, add student to family members array
    if (familyId) {
      const Family = (await import('../models/Family.js')).default
      await Family.findByIdAndUpdate(familyId, { $addToSet: { members: student._id } })
    }

    // Link user to student
    user.linkedStudentId = student._id
    await user.save()

    // Create initial status history
    await StudentStatusHistory.create({
      studentId: student._id,
      status: 'active',
      effectiveDate: new Date(),
      comment: `Converted from lead #${lead._id}`,
      changedBy: req.userId,
    })

    // Update lead status (and drop any scheduled callback)
    lead.status = 'enrolled'
    lead.nextCallbackAt = undefined
    await lead.save()

    // Send welcome email with temporary password
    try {
      const portalUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/portal/login` : 'the portal'
      await sendToUser({
        to: lead.email,
        subject: 'Welcome to My Future Campus — Your Portal Account',
        html: `
          <div style="font-family: 'Inter', Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 24px;">
            <div style="text-align: center; margin-bottom: 32px;">
              <h1 style="font-size: 24px; font-weight: 700; color: #004E31; margin: 0;">Welcome to My Future Campus</h1>
              <p style="font-size: 14px; color: #536578; margin-top: 8px;">Your student portal account has been created</p>
            </div>

            <div style="background: #F4F6F9; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
              <p style="font-size: 13px; color: #536578; margin: 0 0 4px;">Your credentials</p>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; font-size: 13px; color: #536578; width: 100px;">Email</td>
                  <td style="padding: 8px 0; font-size: 14px; font-weight: 600; color: #0F1D2E;">${lead.email}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-size: 13px; color: #536578;">Password</td>
                  <td style="padding: 8px 0; font-size: 14px; font-weight: 600; color: #0F1D2E; font-family: monospace; letter-spacing: 1px;">${tempPassword}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-size: 13px; color: #536578;">Roll No</td>
                  <td style="padding: 8px 0; font-size: 14px; font-weight: 600; color: #0F1D2E;">${rollNo}</td>
                </tr>
              </table>
            </div>

            <div style="text-align: center; margin-bottom: 24px;">
              <a href="${portalUrl}" style="display: inline-block; background: #004E31; color: #fff; text-decoration: none; padding: 12px 32px; border-radius: 8px; font-size: 14px; font-weight: 600;">Sign in to Portal</a>
            </div>

            <p style="font-size: 13px; color: #536578; text-align: center;">
              Please change your password after your first login from the Profile page.
            </p>

            <hr style="border: none; border-top: 1px solid #E2E6ED; margin: 24px 0;" />
            <p style="font-size: 11px; color: #94A8BE; text-align: center;">My Future Campus</p>
          </div>
        `,
      })
    } catch (emailErr) {
      console.error('Failed to send welcome email:', emailErr)
      // Don't fail the conversion if email fails
    }

    await logActivity({
      level: 'info', category: 'leads', action: 'lead_converted',
      message: `Lead ${lead.name} converted to student ${rollNo}`, req,
      meta: { leadId: lead._id, studentId: student._id, userId: user._id },
    })

    res.json({
      message: 'Lead converted to student successfully',
      student,
      user: { _id: user._id, email: user.email, displayName: user.displayName },
      rollNo,
      tempPasswordSent: true,
    })
  } catch (err) {
    console.error('Convert lead error:', err)
    if (err.code === 11000) return res.status(400).json({ error: 'Duplicate entry — roll number or email already exists' })
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Lead stats for KPIs ───
export async function getLeadStats(req, res) {
  try {
    const [total, statusStats, sourceStats, thisWeek] = await Promise.all([
      Enrollment.countDocuments(),
      Enrollment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Enrollment.aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }]),
      Enrollment.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
    ])

    const counts = Object.fromEntries(LEAD_STATUSES.map(st => [st, 0]))
    statusStats.forEach(s => { counts[s._id] = s.count })

    res.json({ total, statusCounts: counts, sourceStats, thisWeek })
  } catch (err) {
    console.error('Lead stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
