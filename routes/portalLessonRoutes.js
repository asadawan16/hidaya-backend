import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listLessons, createLesson, getLesson,
  listPermanentLessons, submitPermanentLesson,
  approvePermanentLesson, rejectPermanentLesson,
  getStudentProgress, getStudentCurriculumView, getStudentLessonHistory,
} from '../controllers/portalLessonController.js'

const router = Router()
router.use(portalAuth)

// Daily lessons
router.get('/', requirePermission('lesson.read'), listLessons)
router.post('/', requirePermission('lesson.log'), createLesson)

// Permanent lessons — MUST be before /:id to avoid "permanent" being cast as ObjectId
router.get('/permanent', requirePermission('lesson.read'), listPermanentLessons)
router.post('/permanent', requirePermission('lesson.log'), submitPermanentLesson)
router.post('/permanent/:id/approve', requirePermission('lesson.approve'), approvePermanentLesson)
router.post('/permanent/:id/reject', requirePermission('lesson.approve'), rejectPermanentLesson)

// Student progress
router.get('/progress/:studentId', requirePermission('lesson.read'), getStudentProgress)
router.get('/curriculum-view/:studentId', requirePermission('lesson.read'), getStudentCurriculumView)
// Daily-lesson history for one student — powers the student's own My Progress page
router.get('/history/:studentId', requirePermission('lesson.read'), getStudentLessonHistory)

// Single lesson by ID — AFTER all specific routes
router.get('/:id', requirePermission('lesson.read'), getLesson)

export default router
