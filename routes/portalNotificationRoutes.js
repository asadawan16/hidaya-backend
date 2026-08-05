import { Router } from 'express'
import { portalAuth } from '../middleware/portalAuth.js'
import {
  listNotifications, markRead, markUnread, deleteNotifications,
  registerDeviceHandler, unregisterDeviceHandler,
} from '../controllers/portalNotificationController.js'

const router = Router()
router.use(portalAuth)

router.get('/', listNotifications)
router.post('/read', markRead)
router.post('/unread', markUnread)
router.post('/delete', deleteNotifications)
router.post('/register-device', registerDeviceHandler)
router.post('/unregister-device', unregisterDeviceHandler)

export default router
