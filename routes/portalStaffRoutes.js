import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listStaff, getStaff, updateStaffProfile, createStaffIncrement,
} from '../controllers/portalStaffController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('staff.read'), listStaff)
router.get('/:userId', requirePermission('staff.read'), getStaff)
router.patch('/:userId', requirePermission('staff.manage'), updateStaffProfile)
router.post('/:userId/increment', requirePermission('staff.manage'), createStaffIncrement)

export default router
