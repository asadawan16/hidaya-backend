import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listStudents, getStudent, createStudent, updateStudent,
  deleteStudent, changeStudentStatus, getStudentStats,
  getStudentDetailExtended, addAdminNote, addManualTutorLog,
} from '../controllers/portalStudentController.js'

const router = Router()

router.use(portalAuth)

router.get('/', requirePermission('student.read'), listStudents)
router.get('/stats', requirePermission('student.read'), getStudentStats)
router.get('/:id', requirePermission('student.read'), getStudent)
router.get('/:id/detail', requirePermission('student.read'), getStudentDetailExtended)
router.post('/:id/notes', requirePermission('student.update'), addAdminNote)
router.post('/:id/tutor-log', requirePermission('assignment.manage'), addManualTutorLog)
router.post('/', requirePermission('student.create'), createStudent)
router.patch('/:id', requirePermission('student.update'), updateStudent)
router.patch('/:id/status', requirePermission('student.update'), changeStudentStatus)
router.delete('/:id', requirePermission('student.delete'), deleteStudent)

export default router
