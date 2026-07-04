import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listPayments,
  getPaymentStats,
  updatePayment,
  listPaymentLinks,
  createPaymentLink,
  getPaymentLinkHistory,
  sendPaymentLinkEmail,
  deletePaymentLink,
  listDiscountCodes,
  createDiscountCode,
  toggleDiscountCode,
  deleteDiscountCode,
  listAllPlans,
  updatePlan,
} from '../controllers/portalPaymentController.js'

const router = Router()
router.use(portalAuth)

// Payments
router.get('/payments', requirePermission('finance.read'), listPayments)
router.get('/payments/stats', requirePermission('finance.read'), getPaymentStats)
router.patch('/payments/:id', requirePermission('finance.manage'), updatePayment)

// Payment Links
router.get('/payment-links', requirePermission('finance.read'), listPaymentLinks)
router.post('/payment-links', requirePermission('finance.manage'), createPaymentLink)
router.get('/payment-links/:id/payments', requirePermission('finance.read'), getPaymentLinkHistory)
router.post('/payment-links/:id/send', requirePermission('finance.manage'), sendPaymentLinkEmail)
router.delete('/payment-links/:id', requirePermission('finance.manage'), deletePaymentLink)

// Discount Codes
router.get('/discount-codes', requirePermission('finance.read'), listDiscountCodes)
router.post('/discount-codes', requirePermission('finance.manage'), createDiscountCode)
router.patch('/discount-codes/:id/toggle', requirePermission('finance.manage'), toggleDiscountCode)
router.delete('/discount-codes/:id', requirePermission('finance.manage'), deleteDiscountCode)

// Plans
router.get('/plans', requirePermission('finance.read'), listAllPlans)
router.patch('/plans/:id', requirePermission('finance.manage'), updatePlan)

export default router
