import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listAssignments, createAssignment, endAssignment, getStudentAssignments,
} from '../controllers/portalAssignmentController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('assignment.read'), listAssignments)
router.post('/', requirePermission('assignment.manage'), createAssignment)
router.post('/:id/end', requirePermission('assignment.manage'), endAssignment)
router.get('/student/:studentId', requirePermission('assignment.read'), getStudentAssignments)

export default router
