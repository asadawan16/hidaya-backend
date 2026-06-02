import { Router } from 'express'
import { listPublic, listAll, update } from '../controllers/planController.js'
import auth from '../middleware/auth.js'

const router = Router()

// Public
router.get('/', listPublic)

// Admin
router.get('/all', auth, listAll)
router.patch('/:id', auth, update)

export default router
