import Student from '../models/Student.js'
import StudentClassLink, { newLinkToken } from '../models/StudentClassLink.js'
import { logActivity } from '../utils/activityLogger.js'

/**
 * Per-student class links, managed from the "Student Links" tab of
 * /portal/class-links.
 *
 * The list endpoint is student-first, not link-first: it pages the Student
 * collection with the same filters as the Students page and hangs whatever link
 * exists off each row. That way the admin sees every student (linked or not)
 * and can add a link inline, which is exactly how the tab reads.
 */

const EDITABLE = ['url', 'label', 'tutorName', 'platform', 'timing', 'note', 'theme', 'isActive']

function normalizeUrl(raw) {
  const url = String(raw || '').trim()
  if (!url) return ''
  // Tolerate a pasted "meet.google.com/abc-defg" — students tap it either way.
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

function normalizeTheme(value) {
  if (value === '' || value == null) return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 7 ? n : null
}

// The optional fields a create/update/bulk body may carry, normalized once.
function extraFields(body = {}) {
  return {
    label: String(body.label || '').trim(),
    tutorName: String(body.tutorName || '').trim(),
    platform: body.platform || 'other',
    timing: String(body.timing || '').trim(),
    note: String(body.note || '').trim(),
    theme: normalizeTheme(body.theme),
    isActive: body.isActive !== false,
  }
}

export async function listStudentClassLinks(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { search, status, course, sort, linked } = req.query

    const filter = {}
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: regex }, { rollNo: regex }, { email: regex }, { parentsName: regex }]
    }
    if (status) filter.status = status
    if (course) filter.courseLabels = course

    // "Has a link" / "No link yet" is a property of the OTHER collection, so it
    // has to narrow the student filter by id before paging — filtering the page
    // afterwards would return short pages and a wrong total.
    if (linked === 'yes' || linked === 'no') {
      const linkedIds = await StudentClassLink.find().distinct('student')
      filter._id = linked === 'yes' ? { $in: linkedIds } : { $nin: linkedIds }
    }

    const total = await Student.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    let sortObj = { createdAt: -1 }
    if (sort === 'name') sortObj = { name: 1 }
    if (sort === 'rollNo') sortObj = { rollNo: 1 }
    if (sort === 'status') sortObj = { status: 1 }

    const students = await Student.find(filter)
      .select('name rollNo status courseLabels country phone guardians')
      .sort(sortObj)
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    const links = await StudentClassLink.find({ student: { $in: students.map(s => s._id) } }).lean()
    const byStudent = new Map(links.map(l => [String(l.student), l]))

    const records = students.map(s => ({ ...s, classLink: byStudent.get(String(s._id)) || null }))

    // Summary is over the whole collection, not this page — a per-page count of
    // "12 linked" next to a 400-student roll would be meaningless.
    const [summaryAgg] = await StudentClassLink.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ['$isActive', 1, 0] } },
          clicks: { $sum: '$clicks' },
        },
      },
    ])

    res.json({
      records,
      total,
      page: safePage,
      pages,
      summary: {
        linked: summaryAgg?.total || 0,
        active: summaryAgg?.active || 0,
        clicks: summaryAgg?.clicks || 0,
      },
    })
  } catch (err) {
    console.error('List student class links error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Create-or-replace the link for one student. The tab's "Add link" and
// "Update link" buttons both land here — a student has at most one link, so an
// upsert keyed on the student is the whole contract.
export async function upsertStudentClassLink(req, res) {
  try {
    const { studentId } = req.body
    const url = normalizeUrl(req.body.url)
    if (!studentId) return res.status(400).json({ error: 'Student is required' })
    if (!url) return res.status(400).json({ error: 'Link is required' })

    const student = await Student.findById(studentId).select('name rollNo').lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const existing = await StudentClassLink.findOne({ student: studentId }).lean()

    const link = await StudentClassLink.findOneAndUpdate(
      { student: studentId },
      {
        $set: {
          studentName: student.name,
          rollNo: student.rollNo || '',
          url,
          ...extraFields(req.body),
          updatedBy: req.userId,
        },
        $setOnInsert: { token: newLinkToken(), createdBy: req.userId },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: false },
    ).lean()

    await logActivity({
      level: 'info', category: 'portal',
      action: existing ? 'student_class_link_updated' : 'student_class_link_created',
      message: `Class link ${existing ? 'updated' : 'published'} for ${student.name}`,
      req,
    })

    res.status(existing ? 200 : 201).json(link)
  } catch (err) {
    console.error('Upsert student class link error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateStudentClassLink(req, res) {
  try {
    const link = await StudentClassLink.findById(req.params.id)
    if (!link) return res.status(404).json({ error: 'Class link not found' })

    for (const field of EDITABLE) {
      if (req.body[field] === undefined) continue
      if (field === 'url') link.url = normalizeUrl(req.body.url)
      else if (field === 'theme') link.theme = normalizeTheme(req.body.theme)
      else link[field] = req.body[field]
    }
    if (!link.url) return res.status(400).json({ error: 'Link is required' })

    // Rotating the token retires the old URL — the escape hatch for a link that
    // got forwarded outside the family.
    if (req.body.regenerateToken) link.token = newLinkToken()

    link.updatedBy = req.userId
    await link.save()
    res.json(link.toObject())
  } catch (err) {
    console.error('Update student class link error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteStudentClassLink(req, res) {
  try {
    const link = await StudentClassLink.findByIdAndDelete(req.params.id)
    if (!link) return res.status(404).json({ error: 'Class link not found' })

    await logActivity({
      level: 'warning', category: 'portal', action: 'student_class_link_deleted',
      message: `Class link removed for ${link.studentName}`, req,
    })
    res.json({ message: 'Class link deleted' })
  } catch (err) {
    console.error('Delete student class link error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// One link applied to many students — the "same Zoom room for the whole batch"
// case. Each student still gets their OWN page and token, so the greeting is
// personal and a single student can later be pointed somewhere else.
export async function bulkAssignStudentClassLinks(req, res) {
  try {
    const ids = Array.isArray(req.body.studentIds) ? req.body.studentIds.filter(Boolean) : []
    const url = normalizeUrl(req.body.url)
    if (!ids.length) return res.status(400).json({ error: 'Select at least one student' })
    if (!url) return res.status(400).json({ error: 'Link is required' })

    const students = await Student.find({ _id: { $in: ids } }).select('name rollNo').lean()
    if (!students.length) return res.status(404).json({ error: 'No matching students' })

    const extras = extraFields(req.body)
    // `skipExisting` lets an admin fill the gaps without disturbing students who
    // already have a bespoke link.
    const skipExisting = req.body.skipExisting === true
    let targets = students
    let skipped = 0
    if (skipExisting) {
      const taken = new Set(
        (await StudentClassLink.find({ student: { $in: students.map(s => s._id) } }).select('student').lean())
          .map(l => String(l.student)),
      )
      targets = students.filter(s => !taken.has(String(s._id)))
      skipped = students.length - targets.length
    }

    if (!targets.length) return res.json({ created: 0, updated: 0, skipped })

    const result = await StudentClassLink.bulkWrite(targets.map(s => ({
      updateOne: {
        filter: { student: s._id },
        update: {
          $set: {
            student: s._id,
            studentName: s.name,
            rollNo: s.rollNo || '',
            url,
            ...extras,
            updatedBy: req.userId,
          },
          $setOnInsert: { token: newLinkToken(), createdBy: req.userId },
        },
        upsert: true,
      },
    })))

    await logActivity({
      level: 'info', category: 'portal', action: 'student_class_link_bulk',
      message: `Class link applied to ${targets.length} student(s)`, req,
    })

    res.json({
      created: result.upsertedCount || 0,
      updated: result.modifiedCount || 0,
      skipped,
    })
  } catch (err) {
    console.error('Bulk student class link error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function bulkDeleteStudentClassLinks(req, res) {
  try {
    const ids = Array.isArray(req.body.studentIds) ? req.body.studentIds.filter(Boolean) : []
    if (!ids.length) return res.status(400).json({ error: 'Select at least one student' })

    const { deletedCount } = await StudentClassLink.deleteMany({ student: { $in: ids } })

    await logActivity({
      level: 'warning', category: 'portal', action: 'student_class_link_bulk_deleted',
      message: `Class links removed for ${deletedCount} student(s)`, req,
    })
    res.json({ deleted: deletedCount })
  } catch (err) {
    console.error('Bulk delete student class links error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
