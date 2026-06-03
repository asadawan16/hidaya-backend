import { Router } from 'express'
import { create, list, search, getById, update, remove, getPayments } from '../controllers/studentController.js'
import auth from '../middleware/auth.js'

const router = Router()

router.post('/', auth, create)
router.get('/', auth, list)
router.get('/search', auth, search)
router.get('/:id', auth, getById)
router.patch('/:id', auth, update)
router.delete('/:id', auth, remove)
router.get('/:id/payments', auth, getPayments)

export default router
