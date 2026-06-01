import { Router } from 'express'
import { create, list, stats, updateStatus } from '../controllers/enrollmentController.js'
import auth from '../middleware/auth.js'

const router = Router()

// Public
router.post('/', create)

// Admin
router.get('/', auth, list)
router.get('/stats', auth, stats)
router.patch('/:id', auth, updateStatus)

export default router
