import { Router } from 'express'
import { list, stats, clearOld } from '../controllers/logController.js'
import auth from '../middleware/auth.js'

const router = Router()

// All log routes require authentication (admin or developer)
router.get('/', auth, list)
router.get('/stats', auth, stats)
router.delete('/clear', auth, clearOld)

export default router
