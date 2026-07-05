import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listAttendance, checkIn, checkOut, markAbsent, getAttendanceSummary, getMyTodayAttendance,
} from '../controllers/portalAttendanceController.js'

const router = Router()
router.use(portalAuth)

// Self-scoped: a tutor's own today status (no tutor.read needed)
router.get('/my-today', getMyTodayAttendance)
router.get('/', requirePermission('tutor.read'), listAttendance)
router.get('/summary', requirePermission('tutor.read'), getAttendanceSummary)
router.post('/check-in', checkIn)
router.post('/check-out', checkOut)
router.post('/mark-absent', requirePermission('tutor.update'), markAbsent)

export default router
