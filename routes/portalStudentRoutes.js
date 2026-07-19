import { Router } from 'express'
import { portalAuth, requirePermission, requireAnyPermission } from '../middleware/portalAuth.js'
import {
  listStudents, getStudent, createStudent, updateStudent,
  deleteStudent, changeStudentStatus, getStudentStats,
  getStudentDetailExtended, addAdminNote, addManualTutorLog,
  addStudentFeedback, deleteStudentFeedback,
  pickerStudents, checkRollNo,
} from '../controllers/portalStudentController.js'

const router = Router()

router.use(portalAuth)

router.get('/', requirePermission('student.read'), listStudents)
router.get('/stats', requirePermission('student.read'), getStudentStats)
// Typeahead picker: full student.read OR the narrow student.pick (lesson/assessment
// logging) — lets tutors select a student without the directory or counts.
router.get('/picker', requireAnyPermission('student.read', 'student.pick'), pickerStudents)
// Literal route must precede '/:id' so it isn't captured as an id
router.get('/check-rollno', requirePermission('student.read'), checkRollNo)
router.get('/:id', requirePermission('student.read'), getStudent)
router.get('/:id/detail', requirePermission('student.read'), getStudentDetailExtended)
router.post('/:id/notes', requirePermission('student.update'), addAdminNote)
// Fine-grained feedback-type permission is enforced inside the controller
router.post('/:id/feedback', requirePermission('student.read'), addStudentFeedback)
router.delete('/:id/feedback/:feedbackId', requirePermission('student.read'), deleteStudentFeedback)
router.post('/:id/tutor-log', requirePermission('assignment.manage'), addManualTutorLog)
router.post('/', requirePermission('student.create'), createStudent)
router.patch('/:id', requirePermission('student.update'), updateStudent)
router.patch('/:id/status', requirePermission('student.update'), changeStudentStatus)
router.delete('/:id', requirePermission('student.delete'), deleteStudent)

export default router
