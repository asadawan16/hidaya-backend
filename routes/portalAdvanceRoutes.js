import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listAdvances, createAdvance, updateAdvance, getAdvance,
  requestAdvance, approveAdvance, rejectAdvance,
} from '../controllers/portalAdvanceController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('advance.read'), listAdvances)
// Tutor self-service request (before the /:id routes)
router.post('/request', requirePermission('advance.request'), requestAdvance)
router.get('/:id', requirePermission('advance.read'), getAdvance)
router.post('/', requirePermission('advance.manage'), createAdvance)
router.post('/:id/approve', requirePermission('advance.manage'), approveAdvance)
router.post('/:id/reject', requirePermission('advance.manage'), rejectAdvance)
router.patch('/:id', requirePermission('advance.manage'), updateAdvance)

export default router
