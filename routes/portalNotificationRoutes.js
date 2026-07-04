import { Router } from 'express'
import { portalAuth } from '../middleware/portalAuth.js'
import { listNotifications, markRead, markUnread, deleteNotifications } from '../controllers/portalNotificationController.js'

const router = Router()
router.use(portalAuth)

router.get('/', listNotifications)
router.post('/read', markRead)
router.post('/unread', markUnread)
router.post('/delete', deleteNotifications)

export default router
