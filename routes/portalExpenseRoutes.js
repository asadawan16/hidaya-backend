import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listExpenses, createExpense, updateExpense, deleteExpense, getExpenseStats,
} from '../controllers/portalExpenseController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('expense.read'), listExpenses)
router.get('/stats', requirePermission('expense.read'), getExpenseStats)
router.post('/', requirePermission('expense.manage'), createExpense)
router.patch('/:id', requirePermission('expense.manage'), updateExpense)
router.delete('/:id', requirePermission('expense.manage'), deleteExpense)

export default router
