import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { denyStudentAccounts } from '../middleware/studentScope.js'
import { getReminderState, sendClassReminder } from '../controllers/portalClassReminderController.js'

// A tutor's WhatsApp class reminders. whatsapp.reminder is granted per person
// from the WhatsApp page; the controller further limits each call to the
// caller's own classes.
const router = Router()
router.use(portalAuth, denyStudentAccounts, requirePermission('whatsapp.reminder'))

router.get('/', getReminderState)
router.post('/:sessionId', sendClassReminder)

export default router
