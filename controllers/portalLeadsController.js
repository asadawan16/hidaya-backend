import crypto from 'crypto'
import Enrollment from '../models/Enrollment.js'
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
  const last = await Student.findOne({ rollNo: { $regex: /^HID\d+$/ } })
    .sort({ rollNo: -1 }).select('rollNo').lean()
  if (!last) return 'HID01'
  const num = parseInt(last.rollNo.replace('HID', ''), 10) + 1
  return `HID${String(num).padStart(2, '0')}`
}

// ─── List leads (enrollments) with stats ───
export async function listLeads(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { status, search, source, sort } = req.query

    const filter = {}
    if (status) filter.status = status
    if (source) filter.source = source
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: regex }, { email: regex }, { phone: regex }]
    }

    const total = await Enrollment.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    let sortObj = { createdAt: -1 }
    if (sort === 'name') sortObj = { name: 1 }
    if (sort === 'status') sortObj = { status: 1, createdAt: -1 }

    const records = await Enrollment.find(filter)
      .populate('referredByStudent', 'name rollNo')
      .sort(sortObj)
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    // Stats
    const stats = await Enrollment.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    const statusCounts = { new: 0, contacted: 0, enrolled: 0, closed: 0 }
    stats.forEach(s => { statusCounts[s._id] = s.count })

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

    const lead = await Enrollment.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone?.trim() || '',
      message: message?.trim() || '',
      source: source || 'manual',
      status: status || 'new',
      referralSource: referralSource?.trim() || '',
      referredByStudent: referredByStudent || undefined,
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
    const lead = await Enrollment.findById(req.params.id).lean()
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
    if (status) lead.status = status
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

    // Update lead status
    lead.status = 'enrolled'
    await lead.save()

    // Send welcome email with temporary password
    try {
      const portalUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/portal/login` : 'the portal'
      await sendToUser({
        to: lead.email,
        subject: 'Welcome to Hidaya Online — Your Portal Account',
        html: `
          <div style="font-family: 'Inter', Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 24px;">
            <div style="text-align: center; margin-bottom: 32px;">
              <h1 style="font-size: 24px; font-weight: 700; color: #0C3B2E; margin: 0;">Welcome to Hidaya Online</h1>
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
              <a href="${portalUrl}" style="display: inline-block; background: #0C3B2E; color: #fff; text-decoration: none; padding: 12px 32px; border-radius: 8px; font-size: 14px; font-weight: 600;">Sign in to Portal</a>
            </div>

            <p style="font-size: 13px; color: #536578; text-align: center;">
              Please change your password after your first login from the Profile page.
            </p>

            <hr style="border: none; border-top: 1px solid #E2E6ED; margin: 24px 0;" />
            <p style="font-size: 11px; color: #94A8BE; text-align: center;">Hidaya Online Education</p>
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

    const counts = { new: 0, contacted: 0, enrolled: 0, closed: 0 }
    statusStats.forEach(s => { counts[s._id] = s.count })

    res.json({ total, statusCounts: counts, sourceStats, thisWeek })
  } catch (err) {
    console.error('Lead stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
