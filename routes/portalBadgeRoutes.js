import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listBadges, createBadge, approveBadge, rejectBadge,
  getUnacknowledgedBadges, acknowledgeBadge, getStudentBadges,
} from '../controllers/portalBadgeController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('badge.read'), listBadges)
router.get('/unacknowledged', getUnacknowledgedBadges)
router.get('/student/:studentId', requirePermission('badge.read'), getStudentBadges)
router.post('/', requirePermission('badge.submit'), createBadge)
router.post('/:id/approve', requirePermission('badge.approve'), approveBadge)
router.post('/:id/reject', requirePermission('badge.approve'), rejectBadge)
router.post('/:id/acknowledge', acknowledgeBadge)

export default router
