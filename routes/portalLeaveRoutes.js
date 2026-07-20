import { Router } from 'express'
import { portalAuth, requireAnyPermission } from '../middleware/portalAuth.js'
import { listLeaves, createLeave, reviewLeave, getLeaveStats } from '../controllers/portalLeaveController.js'

const router = Router()
router.use(portalAuth)

router.get('/', listLeaves)
router.get('/stats', getLeaveStats)
router.post('/', createLeave)
// Reviewing leave is a leave action — accept the dedicated leave.review as well as
// the legacy tutor.update, so leave.review is no longer a dead permission.
router.post('/:id/review', requireAnyPermission('leave.review', 'tutor.update'), reviewLeave)

export default router
