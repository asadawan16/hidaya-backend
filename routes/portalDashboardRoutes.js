import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { getDashboardCharts, getRevenueStats } from '../controllers/portalDashboardController.js'

const router = Router()

router.use(portalAuth)

router.get('/charts', getDashboardCharts)
router.get('/revenue', requirePermission('revenue.read'), getRevenueStats)

export default router
