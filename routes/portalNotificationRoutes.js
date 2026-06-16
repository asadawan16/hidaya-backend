import { Router } from 'express'
import { portalAuth } from '../middleware/portalAuth.js'
import { listNotifications, markRead } from '../controllers/portalNotificationController.js'

const router = Router()
router.use(portalAuth)

router.get('/', listNotifications)
router.post('/read', markRead)

export default router
