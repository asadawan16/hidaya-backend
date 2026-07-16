import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listProgressStudents,
  getStudentProgressDetail,
  getStudentClasses,
} from '../controllers/portalStudentProgressController.js'

const router = Router()

router.use(portalAuth)

router.get('/', requirePermission('student_progress.read'), listProgressStudents)
router.get('/:id/classes', requirePermission('student_progress.read'), getStudentClasses)
router.get('/:id', requirePermission('student_progress.read'), getStudentProgressDetail)

export default router
