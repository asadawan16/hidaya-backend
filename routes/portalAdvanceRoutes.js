import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listAdvances, createAdvance, updateAdvance, getAdvance,
} from '../controllers/portalAdvanceController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('advance.read'), listAdvances)
router.get('/:id', requirePermission('advance.read'), getAdvance)
router.post('/', requirePermission('advance.manage'), createAdvance)
router.patch('/:id', requirePermission('advance.manage'), updateAdvance)

export default router
