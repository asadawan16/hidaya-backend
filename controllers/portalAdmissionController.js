import AdmissionApplication from '../models/AdmissionApplication.js'
import Student from '../models/Student.js'
import Family from '../models/Family.js'
import StudentRelationship from '../models/StudentRelationship.js'
import StudentStatusHistory from '../models/StudentStatusHistory.js'
import { logActivity } from '../utils/activityLogger.js'
import { notifyRoles } from './portalNotificationController.js'
import { sendToUser, admissionDecisionEmail } from '../services/mailer.js'

/** Email the primary guardian about an admission decision — never throws. */
async function emailAdmissionDecision(admission, { approved, rollNo }) {
  try {
    const to = admission.guardians?.find(g => g.email)?.email
    if (!to) return
    const { subject, html } = admissionDecisionEmail({
      studentName: admission.studentName,
      approved,
      rollNo,
      reviewNotes: approved ? '' : (admission.reviewNotes || ''),
    })
    await sendToUser({ to, subject, html })
  } catch (e) {
    console.error('Admission decision email failed:', e.message)
  }
}

// Generate next roll number
async function generateRollNo() {
  const last = await Student.findOne({ rollNo: { $regex: /^HID\d+$/ } })
    .sort({ rollNo: -1 })
    .select('rollNo')
    .lean()

  if (!last) return 'HID01'
  const num = parseInt(last.rollNo.replace('HID', ''), 10) + 1
  return `HID${String(num).padStart(2, '0')}`
}

// Public: submit admission
export async function submitAdmission(req, res) {
  try {
    const data = req.body

    if (!data.studentName) {
      return res.status(400).json({ error: 'Student name is required' })
    }
    if (!data.guardians || data.guardians.length === 0) {
      return res.status(400).json({ error: 'At least one guardian is required' })
    }

    const application = await AdmissionApplication.create({
      ...data,
      status: 'pending',
    })

    await notifyRoles(['super_admin', 'admin'], {
      type: 'admission',
      title: 'New Admission Application',
      body: `${data.studentName} has submitted an admission application.`,
      payload: { applicationId: application._id },
    })

    res.status(201).json({
      message: 'Application submitted successfully',
      applicationId: application._id,
    })
  } catch (err) {
    console.error('Submit admission error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Admin: list admissions
export async function listAdmissions(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { status, search, sort } = req.query

    const filter = {}
    if (status) filter.status = status
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ studentName: regex }, { 'guardians.name': regex }, { 'guardians.phone': regex }]
    }

    const total = await AdmissionApplication.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    let sortObj = { createdAt: -1 }
    if (sort === 'name') sortObj = { studentName: 1 }
    if (sort === 'status') sortObj = { status: 1, createdAt: -1 }

    const records = await AdmissionApplication.find(filter)
      .populate('reviewedBy', 'displayName email')
      .sort(sortObj)
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    // Stats
    const stats = await AdmissionApplication.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    const statusCounts = {}
    stats.forEach(s => { statusCounts[s._id] = s.count })

    res.json({ records, total, page: safePage, pages, statusCounts })
  } catch (err) {
    console.error('List admissions error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Admin: get single admission
export async function getAdmission(req, res) {
  try {
    const admission = await AdmissionApplication.findById(req.params.id)
      .populate('reviewedBy', 'displayName email')
      .populate('studentId', 'name rollNo')
      .lean()

    if (!admission) return res.status(404).json({ error: 'Application not found' })

    res.json(admission)
  } catch (err) {
    console.error('Get admission error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Admin: approve admission
export async function approveAdmission(req, res) {
  try {
    const admission = await AdmissionApplication.findById(req.params.id)
    if (!admission) return res.status(404).json({ error: 'Application not found' })
    if (admission.status !== 'pending') {
      return res.status(400).json({ error: 'Application is not pending' })
    }

    const { rollNo, familyCode, billing, reviewNotes, proposedRelationships } = req.body

    // Generate roll number
    const finalRollNo = rollNo || await generateRollNo()

    // Check roll number uniqueness
    const existingStudent = await Student.findOne({ rollNo: finalRollNo })
    if (existingStudent) {
      return res.status(400).json({ error: 'Roll number already exists' })
    }

    // Handle family
    let familyId = null
    if (familyCode) {
      let family = await Family.findOne({ familyCode: familyCode.toUpperCase() })
      if (!family) {
        const guardian = admission.guardians?.[0]
        family = await Family.create({
          familyCode: familyCode.toUpperCase(),
          primaryGuardian: {
            name: guardian?.name || '',
            phone: guardian?.phone || '',
            email: guardian?.email || '',
            relation: guardian?.relation || '',
          },
        })
      }
      familyId = family._id
    }

    // Create student
    const student = await Student.create({
      rollNo: finalRollNo,
      name: admission.studentName,
      parentsName: admission.parentsName,
      dob: admission.dob,
      country: admission.country,
      timezone: admission.timezone,
      guardians: admission.guardians,
      whatsappNumber: admission.whatsappNumber,
      courseLabels: admission.courseLabels,
      placementLevel: admission.placementLevel,
      sect: admission.sect,
      specialNeeds: admission.specialNeeds,
      referredBy: admission.referredBy || admission.heardFrom,
      billing: billing || {},
      familyId,
      status: 'active',
    })

    // Add student to family
    if (familyId) {
      await Family.findByIdAndUpdate(familyId, { $addToSet: { members: student._id } })
    }

    // Create relationships
    if (proposedRelationships?.length > 0) {
      for (const rel of proposedRelationships) {
        if (!rel.relatedRollNo) continue
        const relatedStudent = await Student.findOne({ rollNo: rel.relatedRollNo })
        if (relatedStudent) {
          await StudentRelationship.create({
            studentA: student._id,
            studentB: relatedStudent._id,
            type: rel.type || 'sibling',
          })
        }
      }
    }

    // Create initial status history
    await StudentStatusHistory.create({
      studentId: student._id,
      status: 'active',
      effectiveDate: new Date(),
      comment: 'Admission approved',
      changedBy: req.userId,
    })

    // Update admission
    admission.status = 'approved'
    admission.reviewedBy = req.userId
    admission.reviewedAt = new Date()
    admission.reviewNotes = reviewNotes || ''
    admission.studentId = student._id
    admission.proposedRelationships = proposedRelationships || []
    await admission.save()

    await logActivity({
      level: 'info',
      category: 'admission',
      action: 'admission_approved',
      message: `Admission approved: ${student.name} → ${student.rollNo}`,
      req,
      meta: { admissionId: admission._id, studentId: student._id },
    })

    await emailAdmissionDecision(admission, { approved: true, rollNo: finalRollNo })

    res.json({ message: 'Admission approved', student, admission })
  } catch (err) {
    console.error('Approve admission error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Admin: reject admission
export async function rejectAdmission(req, res) {
  try {
    const admission = await AdmissionApplication.findById(req.params.id)
    if (!admission) return res.status(404).json({ error: 'Application not found' })
    if (admission.status !== 'pending') {
      return res.status(400).json({ error: 'Application is not pending' })
    }

    admission.status = 'rejected'
    admission.reviewedBy = req.userId
    admission.reviewedAt = new Date()
    admission.reviewNotes = req.body.reviewNotes || ''
    await admission.save()

    await logActivity({
      level: 'info',
      category: 'admission',
      action: 'admission_rejected',
      message: `Admission rejected: ${admission.studentName}`,
      req,
      meta: { admissionId: admission._id },
    })

    await emailAdmissionDecision(admission, { approved: false })

    res.json({ message: 'Admission rejected', admission })
  } catch (err) {
    console.error('Reject admission error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
