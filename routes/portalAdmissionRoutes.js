import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  submitAdmission, listAdmissions, getAdmission,
  approveAdmission, rejectAdmission,
} from '../controllers/portalAdmissionController.js'

const router = Router()

// Public route — no auth needed for submission
router.post('/submit', submitAdmission)

// Admin routes
router.get('/', portalAuth, requirePermission('enrollment.read'), listAdmissions)
router.get('/:id', portalAuth, requirePermission('enrollment.read'), getAdmission)
router.post('/:id/approve', portalAuth, requirePermission('student.approve'), approveAdmission)
router.post('/:id/reject', portalAuth, requirePermission('student.approve'), rejectAdmission)

export default router
