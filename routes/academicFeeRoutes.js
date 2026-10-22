import { Router } from 'express'
import { getPublic } from '../controllers/academicFeeController.js'

// Public: what the Fee page shows about academic fees. Edited in the portal
// at /portal/billing/academic-fees (portalPaymentRoutes.js).
const router = Router()
router.get('/', getPublic)

export default router
