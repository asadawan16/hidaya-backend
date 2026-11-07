import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  getFeeGrid, upsertFeeCell, createFeePayment, listFeePayments,
  deleteFeePayment, updateFeePayment, listLinkablePayments, bulkUpsertReceivables, resetFeeMonths,
  getStudentFeeHistory, getMyFees,
  getFeeDues, getFeeDuesSummary, getFeeReminderSettings, updateFeeReminderSettings, sendFeeReminderNow,
} from '../controllers/portalFeeController.js'

const router = Router()

router.use(portalAuth)

// A student's own fees — authorized by the account's linkedStudentId, not by a
// finance permission (students hold none). Must precede the fee.read routes.
router.get('/my', getMyFees)

router.get('/grid', requirePermission('fee.read'), getFeeGrid)
router.get('/student/:studentId/history', requirePermission('fee.read'), getStudentFeeHistory)
router.get('/payments', requirePermission('fee.read'), listFeePayments)
router.get('/dues', requirePermission('fee.read'), getFeeDues)
router.get('/dues/summary', requirePermission('fee.read'), getFeeDuesSummary)
router.get('/reminders/settings', requirePermission('fee.read'), getFeeReminderSettings)
router.put('/reminders/settings', requirePermission('fee.manage'), updateFeeReminderSettings)
router.post('/reminders/send', requirePermission('fee.manage'), sendFeeReminderNow)
router.get('/linkable-payments', requirePermission('fee.read'), listLinkablePayments)
router.patch('/cell', requirePermission('fee.manage'), upsertFeeCell)
router.patch('/receivables', requirePermission('fee.manage'), bulkUpsertReceivables)
router.post('/reset', requirePermission('fee.manage'), resetFeeMonths)
router.post('/payments', requirePermission('fee.manage'), createFeePayment)
router.patch('/payments/:id', requirePermission('fee.manage'), updateFeePayment)
router.delete('/payments/:id', requirePermission('fee.manage'), deleteFeePayment)

export default router
