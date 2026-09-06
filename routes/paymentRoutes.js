import { Router } from 'express'
import { initiate, initiatePayPal, initiateStripe, callback, list, getStats, update } from '../controllers/paymentController.js'
import { publicSettings, getSettings, updateSettings } from '../controllers/paymentSettingsController.js'
import auth from '../middleware/auth.js'

const router = Router()

// Public
router.post('/initiate', initiate)
router.post('/initiate-paypal', initiatePayPal)
router.post('/initiate-stripe', initiateStripe)
router.post('/callback', callback)
// Which gateway the fee page should check out through
router.get('/settings', publicSettings)

// Admin
router.get('/', auth, list)
router.get('/stats', auth, getStats)
// Declared before '/:id' so 'settings' is never read as a payment id.
router.get('/settings/admin', auth, getSettings)
router.patch('/settings', auth, updateSettings)
router.patch('/:id', auth, update)

export default router
