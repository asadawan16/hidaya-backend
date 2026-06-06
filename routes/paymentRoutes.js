import { Router } from 'express'
import { initiate, initiatePayPal, callback, list, getStats, update } from '../controllers/paymentController.js'
import auth from '../middleware/auth.js'

const router = Router()

// Public
router.post('/initiate', initiate)
router.post('/initiate-paypal', initiatePayPal)
router.post('/callback', callback)

// Admin
router.get('/', auth, list)
router.get('/stats', auth, getStats)
router.patch('/:id', auth, update)

export default router
