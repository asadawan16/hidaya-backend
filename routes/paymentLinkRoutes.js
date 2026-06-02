import { Router } from 'express'
import { create, sendEmail, list, getStats, remove, getByToken, initiate, callback } from '../controllers/paymentLinkController.js'
import auth from '../middleware/auth.js'

const router = Router()

// Public — accessed via payment link
router.get('/t/:token', getByToken)
router.post('/t/:token/pay', initiate)
router.post('/t/:token/callback', callback)

// Admin
router.post('/', auth, create)
router.get('/', auth, list)
router.get('/stats', auth, getStats)
router.post('/:id/send', auth, sendEmail)
router.delete('/:id', auth, remove)

export default router
