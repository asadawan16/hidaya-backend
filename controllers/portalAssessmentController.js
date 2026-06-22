import AssessmentTemplate from '../models/AssessmentTemplate.js'
import Assessment from '../models/Assessment.js'
import { logActivity } from '../utils/activityLogger.js'

// ─── Templates ───

export async function listTemplates(req, res) {
  try {
    const filter = {}
    if (req.query.active === 'true') filter.active = true
    const templates = await AssessmentTemplate.find(filter).sort({ createdAt: -1 }).lean()
    res.json(templates)
  } catch (err) {
    console.error('List templates error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createTemplate(req, res) {
  try {
    const { name, sections } = req.body
    if (!name) return res.status(400).json({ error: 'Name is required' })

    const template = await AssessmentTemplate.create({
      name, sections: sections || [], active: true, createdBy: req.userId,
    })

    await logActivity({ level: 'info', category: 'assessment', action: 'template_created', message: `Template created: ${name}`, req })
    res.status(201).json(template)
  } catch (err) {
    console.error('Create template error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateTemplate(req, res) {
  try {
    const template = await AssessmentTemplate.findById(req.params.id)
    if (!template) return res.status(404).json({ error: 'Template not found' })

    const { name, sections, active } = req.body
    if (name !== undefined) template.name = name
    if (sections !== undefined) template.sections = sections
    if (active !== undefined) template.active = active
    await template.save()

    res.json(template)
  } catch (err) {
    console.error('Update template error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteTemplate(req, res) {
  try {
    await AssessmentTemplate.findByIdAndUpdate(req.params.id, { active: false })
    res.json({ message: 'Template deactivated' })
  } catch (err) {
    console.error('Delete template error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Assessments ───

export async function listAssessments(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { studentId, dateFrom, dateTo } = req.query

    const filter = {}
    // Scope: students see only their own, tutors see only assessments they conducted/are assigned to
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
    } else if (req.user.linkedTutorId) {
      filter.$or = [
        { testTeacherId: req.user.linkedTutorId },
        { regularTeacherId: req.user.linkedTutorId },
      ]
      if (studentId) filter.studentId = studentId
    } else {
      if (studentId) filter.studentId = studentId
    }
    if (dateFrom || dateTo) {
      filter.date = {}
      if (dateFrom) filter.date.$gte = new Date(dateFrom)
      if (dateTo) filter.date.$lte = new Date(dateTo)
    }

    const total = await Assessment.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1

    const records = await Assessment.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('templateId', 'name')
      .populate('testTeacherId', 'name tutorId')
      .populate('regularTeacherId', 'name tutorId')
      .sort({ date: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: pg, pages })
  } catch (err) {
    console.error('List assessments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createAssessment(req, res) {
  try {
    const data = req.body
    if (!data.studentId || !data.templateId || !data.date) {
      return res.status(400).json({ error: 'studentId, templateId, and date are required' })
    }

    const assessment = await Assessment.create({
      ...data,
      conductedBy: req.userId,
    })

    await logActivity({ level: 'info', category: 'assessment', action: 'assessment_created', message: `Assessment recorded for student ${data.studentId}`, req })

    const populated = await Assessment.findById(assessment._id)
      .populate('studentId', 'name rollNo')
      .populate('templateId', 'name')
      .lean()

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create assessment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getAssessment(req, res) {
  try {
    const assessment = await Assessment.findById(req.params.id)
      .populate('studentId', 'name rollNo')
      .populate('templateId')
      .populate('testTeacherId', 'name tutorId')
      .populate('regularTeacherId', 'name tutorId')
      .lean()

    if (!assessment) return res.status(404).json({ error: 'Assessment not found' })
    res.json(assessment)
  } catch (err) {
    console.error('Get assessment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
