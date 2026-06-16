import { Router } from 'express'
import { portalLogin, portalGetMe, enrollMfa, revokeMfa } from '../controllers/portalAuthController.js'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'

const router = Router()

router.post('/login', portalLogin)
router.get('/me', portalAuth, portalGetMe)
router.post('/mfa/enroll', portalAuth, requirePermission('mfa.enroll'), enrollMfa)
router.post('/mfa/revoke', portalAuth, requirePermission('mfa.revoke'), revokeMfa)

export default router
