import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { getShiftConfig, updateShiftConfig } from '../controllers/portalShiftConfigController.js'

const router = Router()
router.use(portalAuth)

router.get('/', getShiftConfig)
router.put('/', requirePermission('salary.manage'), updateShiftConfig)

export default router
