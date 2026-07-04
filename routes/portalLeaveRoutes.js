import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { listLeaves, createLeave, reviewLeave, getLeaveStats } from '../controllers/portalLeaveController.js'

const router = Router()
router.use(portalAuth)

router.get('/', listLeaves)
router.get('/stats', getLeaveStats)
router.post('/', createLeave)
router.post('/:id/review', requirePermission('tutor.update'), reviewLeave)

export default router
