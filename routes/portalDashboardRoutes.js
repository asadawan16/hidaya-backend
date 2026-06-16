import { Router } from 'express'
import { portalAuth } from '../middleware/portalAuth.js'
import { getDashboardCharts } from '../controllers/portalDashboardController.js'

const router = Router()

router.use(portalAuth)

router.get('/charts', getDashboardCharts)

export default router
