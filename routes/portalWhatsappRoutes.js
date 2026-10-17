import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  getConnection, connect, resync, disconnect, listMessages, send, getTemplates, addTemplate,
} from '../controllers/portalWhatsappController.js'

const router = Router()
router.use(portalAuth, requirePermission('whatsapp.manage'))

router.get('/connection', getConnection)
router.post('/connect', connect)
router.post('/sync', resync)
router.delete('/connection', disconnect)
router.get('/messages', listMessages)
router.post('/messages', send)
router.get('/templates', getTemplates)
router.post('/templates', addTemplate)

export default router
