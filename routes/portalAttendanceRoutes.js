import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listAttendance, checkIn, checkOut, getAttendanceSummary,
} from '../controllers/portalAttendanceController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('tutor.read'), listAttendance)
router.get('/summary', requirePermission('tutor.read'), getAttendanceSummary)
router.post('/check-in', checkIn)
router.post('/check-out', checkOut)

export default router
