import { Router } from 'express'
import { subscribe, unsubscribe, list, stats, remove, sendNewsletter } from '../controllers/subscriberController.js'
import auth from '../middleware/auth.js'

const router = Router()

// Public
router.post('/subscribe', subscribe)
router.post('/unsubscribe', unsubscribe)

// Admin
router.get('/', auth, list)
router.get('/stats', auth, stats)
router.delete('/:id', auth, remove)
router.post('/send', auth, sendNewsletter)

export default router
