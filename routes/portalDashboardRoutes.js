import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { getDashboardCharts, getRevenueStats } from '../controllers/portalDashboardController.js'

const router = Router()

router.use(portalAuth)

router.get('/charts', getDashboardCharts)
router.get('/revenue', requirePermission('finance.read'), getRevenueStats)

export default router
