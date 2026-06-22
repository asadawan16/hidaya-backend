import mongoose from 'mongoose'
import LessonEntry from '../models/LessonEntry.js'
import PermanentLesson from '../models/PermanentLesson.js'
import { logActivity } from '../utils/activityLogger.js'

// ─── Daily Lesson Entries ───

export async function listLessons(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30))
    const { studentId, tutorId, dateFrom, dateTo, kind } = req.query

    const filter = {}
    // Scope: students see only their own, tutors see only their students
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
    } else if (req.user.linkedTutorId) {
      filter.tutorId = req.user.linkedTutorId
      if (studentId) filter.studentId = studentId
    } else {
      if (studentId) filter.studentId = studentId
      if (tutorId) filter.tutorId = tutorId
    }
    if (kind) filter.kind = kind
    if (dateFrom || dateTo) {
      filter.date = {}
      if (dateFrom) filter.date.$gte = new Date(dateFrom)
      if (dateTo) filter.date.$lte = new Date(dateTo)
    }

    const total = await LessonEntry.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await LessonEntry.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId')
      .populate('items.curriculumItemId', 'label track type')
      .sort({ date: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List lessons error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createLesson(req, res) {
  try {
    const { sessionId, studentId, tutorId, date, classStart, classEnd, kind, items, customText, notes } = req.body
    if (!studentId || !tutorId || !date) {
      return res.status(400).json({ error: 'studentId, tutorId, and date are required' })
    }

    const entry = await LessonEntry.create({
      sessionId, studentId, tutorId,
      date: new Date(date),
      classStart: classStart || '',
      classEnd: classEnd || '',
      kind: kind || 'daily',
      items: items || [],
      customText: customText || '',
      notes: notes || '',
    })

    await logActivity({
      level: 'info',
      category: 'lesson',
      action: 'lesson_logged',
      message: `Daily lesson logged for student ${studentId}`,
      req,
      meta: { lessonId: entry._id },
    })

    const populated = await LessonEntry.findById(entry._id)
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId')
      .populate('items.curriculumItemId', 'label track type')
      .lean()

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create lesson error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getLesson(req, res) {
  try {
    const entry = await LessonEntry.findById(req.params.id)
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId')
      .populate('items.curriculumItemId', 'label track type')
      .lean()

    if (!entry) return res.status(404).json({ error: 'Lesson not found' })
    res.json(entry)
  } catch (err) {
    console.error('Get lesson error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Permanent Lessons ───

export async function listPermanentLessons(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30))
    const { studentId, tutorId, status } = req.query

    const filter = {}
    // Scope: students see only their own, tutors see only their students
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
    } else if (req.user.linkedTutorId) {
      filter.tutorId = req.user.linkedTutorId
      if (studentId) filter.studentId = studentId
    } else {
      if (studentId) filter.studentId = studentId
      if (tutorId) filter.tutorId = tutorId
    }
    if (status) filter.status = status

    const total = await PermanentLesson.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await PermanentLesson.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId')
      .populate('curriculumItemId', 'label track type')
      .populate('submittedBy', 'displayName')
      .populate('approvedBy', 'displayName')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    // Stats — use the same scoped filter
    const statsId = filter.studentId || filter.tutorId ? filter : {}
    const statusStats = await PermanentLesson.aggregate([
      ...(Object.keys(statsId).length ? [{ $match: statsId }] : []),
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])

    res.json({ records, total, page: safePage, pages, statusStats })
  } catch (err) {
    console.error('List permanent lessons error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function submitPermanentLesson(req, res) {
  try {
    const { studentId, tutorId, curriculumItemId, completedDate, videoUrl, notes } = req.body
    if (!studentId || !tutorId || !curriculumItemId) {
      return res.status(400).json({ error: 'studentId, tutorId, and curriculumItemId are required' })
    }

    // Check if already submitted for this item
    const existing = await PermanentLesson.findOne({
      studentId, curriculumItemId, status: { $in: ['pending_approval', 'approved'] },
    })
    if (existing) {
      return res.status(400).json({ error: 'This item is already submitted or approved' })
    }

    const lesson = await PermanentLesson.create({
      studentId, tutorId, curriculumItemId,
      completedDate: completedDate ? new Date(completedDate) : new Date(),
      status: 'pending_approval',
      video: videoUrl ? {
        received: true,
        receivedAt: new Date(),
        externalUrl: videoUrl,
        status: 'uploaded',
      } : {},
      submittedBy: req.userId,
      notes: notes || '',
    })

    await logActivity({
      level: 'info',
      category: 'lesson',
      action: 'permanent_lesson_submitted',
      message: `Permanent lesson submitted for student ${studentId}`,
      req,
      meta: { permanentLessonId: lesson._id },
    })

    const populated = await PermanentLesson.findById(lesson._id)
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId')
      .populate('curriculumItemId', 'label track type')
      .lean()

    res.status(201).json(populated)
  } catch (err) {
    console.error('Submit permanent lesson error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function approvePermanentLesson(req, res) {
  try {
    const lesson = await PermanentLesson.findById(req.params.id)
    if (!lesson) return res.status(404).json({ error: 'Permanent lesson not found' })
    if (lesson.status !== 'pending_approval') {
      return res.status(400).json({ error: 'Lesson is not pending approval' })
    }

    lesson.status = 'approved'
    lesson.approvedBy = req.userId
    lesson.approvedAt = new Date()
    lesson.notes = req.body.notes || lesson.notes
    await lesson.save()

    await logActivity({
      level: 'info',
      category: 'lesson',
      action: 'permanent_lesson_approved',
      message: `Permanent lesson approved: ${lesson._id}`,
      req,
      meta: { permanentLessonId: lesson._id },
    })

    res.json({ message: 'Approved', lesson })
  } catch (err) {
    console.error('Approve permanent lesson error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function rejectPermanentLesson(req, res) {
  try {
    const lesson = await PermanentLesson.findById(req.params.id)
    if (!lesson) return res.status(404).json({ error: 'Permanent lesson not found' })
    if (lesson.status !== 'pending_approval') {
      return res.status(400).json({ error: 'Lesson is not pending approval' })
    }

    lesson.status = 'rejected'
    lesson.rejectionReason = req.body.reason || ''
    lesson.approvedBy = req.userId
    lesson.approvedAt = new Date()
    await lesson.save()

    await logActivity({
      level: 'info',
      category: 'lesson',
      action: 'permanent_lesson_rejected',
      message: `Permanent lesson rejected: ${lesson._id}`,
      req,
      meta: { permanentLessonId: lesson._id },
    })

    res.json({ message: 'Rejected', lesson })
  } catch (err) {
    console.error('Reject permanent lesson error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Student progress (approved permanent lessons) ───

export async function getStudentProgress(req, res) {
  try {
    const { studentId } = req.params
    const approved = await PermanentLesson.find({ studentId, status: 'approved' })
      .populate('curriculumItemId', 'label track type order meta')
      .populate('tutorId', 'name tutorId')
      .sort({ completedDate: 1 })
      .limit(500)
      .lean()

    // Group by track
    const byTrack = {}
    for (const lesson of approved) {
      const track = lesson.curriculumItemId?.track || 'unknown'
      if (!byTrack[track]) byTrack[track] = []
      byTrack[track].push(lesson)
    }

    res.json({ total: approved.length, byTrack, lessons: approved })
  } catch (err) {
    console.error('Get student progress error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
