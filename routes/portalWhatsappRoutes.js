import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  getConnection, connect, connectManual, resync, disconnect, listMessages, send, getTemplates, addTemplate,
  getWebhookFields, enableWebhookFields,
} from '../controllers/portalWhatsappController.js'
import {
  getReminderSettings, updateReminderSettings, createRecommendedTemplate,
  listReminderAccess, setReminderAccess, listReminders,
} from '../controllers/portalClassReminderController.js'
import { listTeamAccess, setTeamAccess } from '../controllers/portalWhatsappAccessController.js'

const router = Router()
router.use(portalAuth, requirePermission('whatsapp.manage'))

router.get('/connection', getConnection)
router.post('/connect', connect)
router.post('/connect-manual', connectManual)
router.post('/sync', resync)
router.get('/webhook-fields', getWebhookFields)
router.post('/webhook-fields', enableWebhookFields)
router.delete('/connection', disconnect)
router.get('/messages', listMessages)
router.post('/messages', send)
router.get('/templates', getTemplates)
router.post('/templates', addTemplate)

// Team access — each person's WhatsApp Chats level (+ their reminder switch, read-only here)
router.get('/access', listTeamAccess)
router.put('/access', setTeamAccess)

// Class reminders — what tutors send, which template, who may send
router.get('/reminders', listReminders)
router.get('/reminders/settings', getReminderSettings)
router.put('/reminders/settings', updateReminderSettings)
router.post('/reminders/template', createRecommendedTemplate)
router.get('/reminders/access', listReminderAccess)
router.put('/reminders/access', setReminderAccess)

export default router
