import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listInvoices, createInvoice, updateInvoiceStatus,
  listSalaryRecords, generateSalary, updateSalaryStatus,
} from '../controllers/portalFinanceController.js'

const router = Router()
router.use(portalAuth)

// Invoices
router.get('/invoices', requirePermission('finance.read'), listInvoices)
router.post('/invoices', requirePermission('finance.manage'), createInvoice)
router.patch('/invoices/:id', requirePermission('finance.manage'), updateInvoiceStatus)

// Salary
router.get('/salary', requirePermission('salary.read'), listSalaryRecords)
router.post('/salary/generate', requirePermission('salary.manage'), generateSalary)
router.patch('/salary/:id', requirePermission('salary.manage'), updateSalaryStatus)

export default router
