import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { downloadExport, getExportStatus, getExportReminder } from '../controllers/portalDataExportController.js'

const router = Router()
router.use(portalAuth, requirePermission('data.export'))

router.get('/status', getExportStatus)
router.get('/reminder', getExportReminder)
router.get('/download', downloadExport)

export default router
