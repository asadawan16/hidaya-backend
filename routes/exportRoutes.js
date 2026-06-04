import { Router } from 'express'
import { exportDatabase, getExportStatus } from '../controllers/exportController.js'
import auth from '../middleware/auth.js'

const router = Router()

router.get('/download', auth, exportDatabase)
router.get('/status', auth, getExportStatus)

export default router
