import mongoose from 'mongoose'
import AssessmentTemplate from '../models/AssessmentTemplate.js'
import Assessment from '../models/Assessment.js'
import Student from '../models/Student.js'
import { logActivity } from '../utils/activityLogger.js'
import { scoreAssessment, effectiveOptionScores } from '../utils/assessmentScore.js'
import { createNotification } from './portalNotificationController.js'

// ─── Templates ───

const hasOptions = (f) => f.type === 'rating' || f.type === 'select'

/**
 * Keep `optionScores` the same length as `options`, each entry a 0–100 number
 * or null ("no %" — a blank box in the editor). A field sent without the array
 * at all keeps it unset, so the standard scale applies.
 */
function cleanSections(sections) {
  return (sections || []).map(sec => ({
    ...sec,
    fields: (sec.fields || []).map(f => {
      if (!hasOptions(f) || !Array.isArray(f.optionScores)) return { ...f, optionScores: undefined }
      const optionScores = (f.options || []).map((_, i) => {
        const v = f.optionScores[i]
        const n = v === null || v === '' ? NaN : Number(v)
        return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null
      })
      return { ...f, optionScores }
    }),
  }))
}

/** Fill in what each option is worth so the editor shows the real numbers. */
function withEffectiveScores(template) {
  return {
    ...template,
    sections: (template.sections || []).map(sec => ({
      ...sec,
      fields: (sec.fields || []).map(f => hasOptions(f) ? { ...f, optionScores: effectiveOptionScores(f) } : f),
    })),
  }
}

export async function listTemplates(req, res) {
  try {
    const filter = {}
    if (req.query.active === 'true') filter.active = true
    const templates = await AssessmentTemplate.find(filter).sort({ createdAt: -1 }).lean()
    res.json(templates.map(withEffectiveScores))
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
      name, sections: cleanSections(sections), active: true, createdBy: req.userId,
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
    if (sections !== undefined) template.sections = cleanSections(sections)
    if (active !== undefined) template.active = active
    await template.save()

    // Answers already recorded against this template are worth whatever the
    // template now says, so a changed % reaches old exams too.
    if (sections !== undefined) await rescoreTemplate(template.toObject())

    res.json(withEffectiveScores(template.toObject()))
  } catch (err) {
    console.error('Update template error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

async function rescoreTemplate(template) {
  const records = await Assessment.find({ templateId: template._id }).select('responses').lean()
  const ops = records.map(a => {
    const { responses, overallScore } = scoreAssessment(template, a.responses || [])
    return { updateOne: { filter: { _id: a._id }, update: { $set: { responses, overallScore } } } }
  })
  if (ops.length) await Assessment.bulkWrite(ops)
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

/**
 * A student may only open their own exams. The list endpoint already scopes
 * them; this covers the by-id reads, which are now reachable by URL
 * (/portal/assessments/:id) and so by editing the id.
 */
function hiddenFrom(req, assessment) {
  const own = req.user.linkedStudentId
  return own && String(assessment.studentId?._id || assessment.studentId) !== String(own)
}

export async function listAssessments(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { studentId, dateFrom, dateTo, search } = req.query

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

    // The Exams list's search box: student name or roll number. (It was sent
    // all along and silently ignored, so typing a name filtered nothing.)
    if (search?.trim()) {
      const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      const ids = (await Student.find({ $or: [{ name: regex }, { rollNo: regex }] }).select('_id').lean()).map(s => s._id)
      filter.studentId = filter.studentId
        ? (ids.some(id => String(id) === String(filter.studentId)) ? filter.studentId : { $in: [] })
        : { $in: ids }
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

    // Frontend sends responses as an object keyed by "sectionKey.fieldKey";
    // normalize to the array-of-{ key, value } shape the schema/report card expect.
    const rawResponses = Array.isArray(data.responses)
      ? data.responses
      : Object.entries(data.responses || {}).map(([key, value]) => ({ key, value }))

    // Derive the per-field + overall percentage from the template so reports and
    // the progress page have a real score to show.
    const template = await AssessmentTemplate.findById(data.templateId).lean()
    const { responses, overallScore } = scoreAssessment(template, rawResponses)

    const assessment = await Assessment.create({
      ...data,
      responses,
      overallScore: data.overallScore != null ? data.overallScore : overallScore,
      conductedBy: req.userId,
    })

    await logActivity({ level: 'info', category: 'assessment', action: 'assessment_created', message: `Assessment recorded for student ${data.studentId}`, req })

    const populated = await Assessment.findById(assessment._id)
      .populate('studentId', 'name rollNo')
      .populate('templateId', 'name')
      .lean()

    const assessedStudent = await Student.findById(data.studentId).select('userId').lean()
    if (assessedStudent?.userId) {
      await createNotification({
        userId: assessedStudent.userId,
        type: 'assessment_recorded',
        title: 'Assessment Recorded',
        body: `A new assessment (${populated.templateId?.name || 'assessment'}) has been recorded for you${data.overallScore != null ? ` — score ${data.overallScore}%` : ''}.`,
        payload: { assessmentId: assessment._id },
      })
    }

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

    if (!assessment || hiddenFrom(req, assessment)) return res.status(404).json({ error: 'Assessment not found' })
    res.json(assessment)
  } catch (err) {
    console.error('Get assessment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateAssessment(req, res) {
  try {
    const data = req.body

    // Same responses normalization as create: accept the frontend's object shape.
    if (data.responses !== undefined) {
      const rawResponses = Array.isArray(data.responses)
        ? data.responses
        : Object.entries(data.responses || {}).map(([key, value]) => ({ key, value }))
      const templateId = data.templateId || (await Assessment.findById(req.params.id).select('templateId').lean())?.templateId
      const template = await AssessmentTemplate.findById(templateId).lean()
      const { responses, overallScore } = scoreAssessment(template, rawResponses)
      data.responses = responses
      if (data.overallScore == null) data.overallScore = overallScore
    }

    const assessment = await Assessment.findByIdAndUpdate(
      req.params.id,
      data,
      { new: true, runValidators: true },
    )
      .populate('studentId', 'name rollNo')
      .populate('templateId', 'name')
      .lean()

    if (!assessment) return res.status(404).json({ error: 'Assessment not found' })

    await logActivity({ level: 'info', category: 'assessment', action: 'assessment_updated', message: `Assessment ${req.params.id} updated`, req })

    res.json(assessment)
  } catch (err) {
    console.error('Update assessment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteAssessment(req, res) {
  try {
    const assessment = await Assessment.findByIdAndDelete(req.params.id)
    if (!assessment) return res.status(404).json({ error: 'Assessment not found' })

    await logActivity({ level: 'info', category: 'assessment', action: 'assessment_deleted', message: `Assessment ${req.params.id} deleted`, req })

    res.json({ success: true })
  } catch (err) {
    console.error('Delete assessment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

const REPORT_CARD_POPULATE = [
  ['studentId', 'name rollNo'],
  ['templateId'],
  ['testTeacherId', 'name tutorId'],
  ['regularTeacherId', 'name tutorId'],
  ['conductedBy', 'displayName'],
]

function populateReportCard(query) {
  for (const [path, select] of REPORT_CARD_POPULATE) query.populate(path, select)
  return query.lean()
}

/** An assessment (populated) → the report-card shape: answers laid out by template section. */
function toReportCard(assessment) {
  const sections = (assessment.templateId?.sections || []).map(section => ({
    key: section.key,
    label: section.label,
    fields: section.fields.map(field => {
      const response = assessment.responses.find(r => r.key === `${section.key}.${field.key}` || r.key === field.key)
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        options: field.options,
        value: response?.value ?? '',
        score: response?.score ?? null,
      }
    }),
  }))

  return { ...assessment, structuredSections: sections }
}

export async function getReportCard(req, res) {
  try {
    const assessment = await populateReportCard(Assessment.findById(req.params.id))
    if (!assessment || hiddenFrom(req, assessment)) return res.status(404).json({ error: 'Assessment not found' })
    res.json(toReportCard(assessment))
  } catch (err) {
    console.error('Get report card error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

const BULK_REPORT_CARD_LIMIT = 100

/**
 * Many report cards in one round trip — the Exams page's "Download all (ZIP)"
 * builds a PDF per exam and would otherwise make one request per exam.
 * Body: { ids: [...] } (max 100; the client batches). Same access rules as the
 * single read: a student only ever gets their own.
 */
export async function getReportCards(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => mongoose.isValidObjectId(id)) : []
    if (!ids.length) return res.status(400).json({ error: 'ids is required' })
    if (ids.length > BULK_REPORT_CARD_LIMIT) {
      return res.status(400).json({ error: `At most ${BULK_REPORT_CARD_LIMIT} report cards per request` })
    }
    const found = await populateReportCard(Assessment.find({ _id: { $in: ids } }))
    const order = new Map(ids.map((id, i) => [String(id), i]))
    res.json(found
      .filter(a => !hiddenFrom(req, a))
      .sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)))
      .map(toReportCard))
  } catch (err) {
    console.error('Bulk report cards error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
