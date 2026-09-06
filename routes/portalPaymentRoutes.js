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
  getPaymentLinkSubscription,
  cancelPaymentLinkSubscription,
  listDiscountCodes,
  createDiscountCode,
  toggleDiscountCode,
  deleteDiscountCode,
  listAllPlans,
  updatePlan,
} from '../controllers/portalPaymentController.js'

const router = Router()
router.use(portalAuth)

// Payments — gated by the granular payment.* perms (NOT finance.*), so a role
// can hold the Finance invoices/salary page without seeing the payments ledger.
router.get('/payments', requirePermission('payment.read'), listPayments)
router.get('/payments/stats', requirePermission('payment.read'), getPaymentStats)
router.patch('/payments/:id', requirePermission('payment.update'), updatePayment)

// Payment Links
router.get('/payment-links', requirePermission('payment_link.read'), listPaymentLinks)
router.post('/payment-links', requirePermission('payment_link.create'), createPaymentLink)
router.get('/payment-links/:id/payments', requirePermission('payment_link.read'), getPaymentLinkHistory)
router.post('/payment-links/:id/send', requirePermission('payment_link.send'), sendPaymentLinkEmail)
router.get('/payment-links/:id/subscription', requirePermission('payment_link.read'), getPaymentLinkSubscription)
// Cancelling recurring billing is destructive, so it rides on the same
// permission as deleting the link rather than introducing a new one.
router.post('/payment-links/:id/cancel-subscription', requirePermission('payment_link.delete'), cancelPaymentLinkSubscription)
router.delete('/payment-links/:id', requirePermission('payment_link.delete'), deletePaymentLink)

// Discount Codes
router.get('/discount-codes', requirePermission('discount_code.read'), listDiscountCodes)
router.post('/discount-codes', requirePermission('discount_code.create'), createDiscountCode)
router.patch('/discount-codes/:id/toggle', requirePermission('discount_code.update'), toggleDiscountCode)
router.delete('/discount-codes/:id', requirePermission('discount_code.delete'), deleteDiscountCode)

// Plans
router.get('/plans', requirePermission('plan.read'), listAllPlans)
router.patch('/plans/:id', requirePermission('plan.update'), updatePlan)

export default router
