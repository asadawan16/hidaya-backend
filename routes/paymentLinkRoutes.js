import { Router } from 'express'
import { create, sendEmail, list, getStats, getPaymentHistory, remove, getByToken, initiate, initiatePayPal, initiateStripe, callback } from '../controllers/paymentLinkController.js'
import auth from '../middleware/auth.js'

const router = Router()

// Public — accessed via payment link
router.get('/t/:token', getByToken)
router.post('/t/:token/pay', initiate)              // Mastercard hosted checkout
router.post('/t/:token/pay-paypal', initiatePayPal) // Mastercard → PayPal
router.post('/t/:token/pay-stripe', initiateStripe) // Stripe hosted checkout (one-off + subscription)
router.post('/t/:token/callback', callback)

// Admin
router.post('/', auth, create)
router.get('/', auth, list)
router.get('/stats', auth, getStats)
router.get('/:id/payments', auth, getPaymentHistory)
router.post('/:id/send', auth, sendEmail)
router.delete('/:id', auth, remove)

export default router
