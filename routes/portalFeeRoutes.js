import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  getFeeGrid, upsertFeeCell, createFeePayment, listFeePayments,
  deleteFeePayment, listLinkablePayments,
} from '../controllers/portalFeeController.js'

const router = Router()

router.use(portalAuth)

router.get('/grid', requirePermission('fee.read'), getFeeGrid)
router.get('/payments', requirePermission('fee.read'), listFeePayments)
router.get('/linkable-payments', requirePermission('fee.read'), listLinkablePayments)
router.patch('/cell', requirePermission('fee.manage'), upsertFeeCell)
router.post('/payments', requirePermission('fee.manage'), createFeePayment)
router.delete('/payments/:id', requirePermission('fee.manage'), deleteFeePayment)

export default router
