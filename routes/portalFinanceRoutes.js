import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listInvoices, createInvoice, updateInvoiceStatus, deleteInvoice,
  listSalaryRecords, generateSalary, updateSalaryStatus, getSalaryReceipt,
  listSalaryIncrements, createSalaryIncrement, getSalaryTimeline, getSalaryRoster,
  updateStaffBaseSalary,
} from '../controllers/portalFinanceController.js'

const router = Router()
router.use(portalAuth)

// Invoices
router.get('/invoices', requirePermission('finance.read'), listInvoices)
router.post('/invoices', requirePermission('finance.manage'), createInvoice)
router.patch('/invoices/:id', requirePermission('finance.manage'), updateInvoiceStatus)
router.delete('/invoices/:id', requirePermission('finance.manage'), deleteInvoice)

// Salary
router.get('/salary', requirePermission('salary.read'), listSalaryRecords)
router.get('/salary/roster', requirePermission('salary.read'), getSalaryRoster)
router.post('/salary/generate', requirePermission('salary.manage'), generateSalary)
router.get('/salary/:id/receipt', requirePermission('salary.read'), getSalaryReceipt)
router.patch('/salary/:id', requirePermission('salary.manage'), updateSalaryStatus)
router.patch('/staff/:userId/base', requirePermission('salary.manage'), updateStaffBaseSalary)

// Salary Increments
router.get('/increments', requirePermission('salary.read'), listSalaryIncrements)
router.post('/increments', requirePermission('salary.manage'), createSalaryIncrement)
router.get('/salary-timeline', requirePermission('salary.read'), getSalaryTimeline)

export default router
