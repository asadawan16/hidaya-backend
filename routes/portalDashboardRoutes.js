import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { getDashboardCharts, getRevenueStats, getCurrencyRates, updateCurrencyRates } from '../controllers/portalDashboardController.js'

const router = Router()

router.use(portalAuth)

router.get('/charts', getDashboardCharts)
router.get('/revenue', requirePermission('revenue.read'), getRevenueStats)
router.get('/currency-rates', requirePermission('revenue.read'), getCurrencyRates)
router.put('/currency-rates', requirePermission('revenue.manage'), updateCurrencyRates)

export default router
