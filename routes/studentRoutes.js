import { Router } from 'express'
import { create, bulkCreate, bulkDelete, list, exportAll, search, getById, update, remove, getPayments } from '../controllers/studentController.js'
import auth from '../middleware/auth.js'

const router = Router()

router.post('/', auth, create)
router.post('/bulk', auth, bulkCreate)
router.post('/bulk-delete', auth, bulkDelete)
router.get('/', auth, list)
router.get('/export', auth, exportAll)
router.get('/search', auth, search)
router.get('/:id', auth, getById)
router.patch('/:id', auth, update)
router.delete('/:id', auth, remove)
router.get('/:id/payments', auth, getPayments)

export default router
