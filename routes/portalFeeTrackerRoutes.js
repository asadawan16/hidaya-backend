import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  getBoard, getStudentPosition, updateEntry,
  createReceipt, listReceipts, getReceipt, deleteReceipt,
} from '../controllers/portalFeeTrackerController.js'

// Fee Tracker (/portal/fee-tracker) — every route needs fee.tracker
// (super admin only by default; grant it to others from the Roles page).
const router = Router()

router.use(portalAuth, requirePermission('fee.tracker'))

router.get('/', getBoard)
router.get('/student/:id', getStudentPosition)
router.patch('/entry', updateEntry)
router.get('/receipts', listReceipts)
router.post('/receipts', createReceipt)
router.get('/receipts/:id', getReceipt)
router.delete('/receipts/:id', deleteReceipt)

export default router
