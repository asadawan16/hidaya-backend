import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listLeads, createLead, getLead, updateLeadStatus, convertToStudent, getLeadStats, addLeadLog,
} from '../controllers/portalLeadsController.js'

const router = Router()
router.use(portalAuth)

// All leads endpoints require super_admin-level access
router.get('/', requirePermission('student.create'), listLeads)
router.post('/', requirePermission('student.create'), createLead)
router.get('/stats', requirePermission('student.create'), getLeadStats)
router.get('/:id', requirePermission('student.create'), getLead)
router.patch('/:id/status', requirePermission('student.create'), updateLeadStatus)
// Call log entry: { note, outcome?, nextCallbackAt?, status?, clearCallback? }
router.post('/:id/log', requirePermission('student.create'), addLeadLog)
router.post('/:id/convert', requirePermission('student.create'), convertToStudent)

export default router
