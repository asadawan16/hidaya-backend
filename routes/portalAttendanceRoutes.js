import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listAttendance, checkIn, checkOut, markAbsent, getAttendanceSummary,
} from '../controllers/portalAttendanceController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('tutor.read'), listAttendance)
router.get('/summary', requirePermission('tutor.read'), getAttendanceSummary)
router.post('/check-in', checkIn)
router.post('/check-out', checkOut)
router.post('/mark-absent', requirePermission('tutor.update'), markAbsent)

export default router
