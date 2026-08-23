import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  getFeeGrid, upsertFeeCell, createFeePayment, listFeePayments,
  deleteFeePayment, listLinkablePayments, bulkUpsertReceivables,
  getStudentFeeHistory, getMyFees,
} from '../controllers/portalFeeController.js'

const router = Router()

router.use(portalAuth)

// A student's own fees — authorized by the account's linkedStudentId, not by a
// finance permission (students hold none). Must precede the fee.read routes.
router.get('/my', getMyFees)

router.get('/grid', requirePermission('fee.read'), getFeeGrid)
router.get('/student/:studentId/history', requirePermission('fee.read'), getStudentFeeHistory)
router.get('/payments', requirePermission('fee.read'), listFeePayments)
router.get('/linkable-payments', requirePermission('fee.read'), listLinkablePayments)
router.patch('/cell', requirePermission('fee.manage'), upsertFeeCell)
router.patch('/receivables', requirePermission('fee.manage'), bulkUpsertReceivables)
router.post('/payments', requirePermission('fee.manage'), createFeePayment)
router.delete('/payments/:id', requirePermission('fee.manage'), deleteFeePayment)

export default router
