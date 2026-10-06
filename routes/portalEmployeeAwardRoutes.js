import { Router } from 'express'
import { denyStudentAccounts } from '../middleware/studentScope.js'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listAwards, getCurrentAward, createAward, acknowledgeAward, getUnacknowledgedAward,
} from '../controllers/portalEmployeeAwardController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('award.read'), listAwards)
router.get('/current', getCurrentAward)
router.get('/unacknowledged', getUnacknowledgedAward)
router.post('/', requirePermission('award.manage'), createAward)
router.post('/:id/acknowledge', denyStudentAccounts, acknowledgeAward)

export default router
