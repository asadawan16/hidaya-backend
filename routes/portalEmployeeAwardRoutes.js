import { Router } from 'express'
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
router.post('/:id/acknowledge', acknowledgeAward)

export default router
