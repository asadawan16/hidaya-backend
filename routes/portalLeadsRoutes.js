import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listLeads, getLead, updateLeadStatus, convertToStudent, getLeadStats,
} from '../controllers/portalLeadsController.js'

const router = Router()
router.use(portalAuth)

// All leads endpoints require super_admin-level access
router.get('/', requirePermission('student.create'), listLeads)
router.get('/stats', requirePermission('student.create'), getLeadStats)
router.get('/:id', requirePermission('student.create'), getLead)
router.patch('/:id/status', requirePermission('student.create'), updateLeadStatus)
router.post('/:id/convert', requirePermission('student.create'), convertToStudent)

export default router
