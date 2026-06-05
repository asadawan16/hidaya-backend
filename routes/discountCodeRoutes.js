import { Router } from 'express'
import { create, list, toggle, remove, validate } from '../controllers/discountCodeController.js'
import auth from '../middleware/auth.js'

const router = Router()

// Public — validate a code before paying
router.post('/validate', validate)

// Admin
router.post('/', auth, create)
router.get('/', auth, list)
router.patch('/:id/toggle', auth, toggle)
router.delete('/:id', auth, remove)

export default router
