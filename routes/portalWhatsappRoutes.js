import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { getConnection, connect, resync, disconnect } from '../controllers/portalWhatsappController.js'

const router = Router()
router.use(portalAuth, requirePermission('whatsapp.manage'))

router.get('/connection', getConnection)
router.post('/connect', connect)
router.post('/sync', resync)
router.delete('/connection', disconnect)

export default router
