import { Router } from 'express'
import { portalAuth, requirePermission, requireRole } from '../middleware/portalAuth.js'
import {
  listSlots, createSlot, updateSlot, deleteSlot,
  listSessions, createSession, updateSession, deleteSession,
  startSession, completeSession, markSessionMissed, resetSession, updateSessionStatus, forceCompleteSession,
  getLiveBoard, getMyLiveSessions, getMyUnloggedSessions, generateSessionsForDate, getBoard, getSlotBoard,
  getScheduleConfig, updateScheduleConfig, getMyAttendanceSummary,
} from '../controllers/portalScheduleController.js'

const router = Router()
router.use(portalAuth)

// Schedule config (auto-generate toggle)
router.get('/config', requirePermission('schedule.read'), getScheduleConfig)
router.put('/config', requirePermission('schedule.manage'), updateScheduleConfig)

// Class Slots
router.get('/slots', requirePermission('schedule.read'), listSlots)
router.post('/slots', requirePermission('schedule.manage'), createSlot)
router.patch('/slots/:id', requirePermission('schedule.manage'), updateSlot)
router.delete('/slots/:id', requirePermission('schedule.manage'), deleteSlot)

// Board view (tutor × time-block grid for a day)
router.get('/board', requirePermission('schedule.read'), getBoard)
// Slot board (tutor × time recurring-slot grid + capacity/spaces for a weekday)
router.get('/slot-board', requirePermission('schedule.read'), getSlotBoard)

// Class Sessions
router.get('/sessions', requirePermission('schedule.read'), listSessions)
router.post('/sessions', requirePermission('schedule.manage'), createSession)
router.post('/sessions/generate', requirePermission('schedule.manage'), generateSessionsForDate)
router.post('/sessions/:id/start', requirePermission('lesson.log'), startSession)
router.post('/sessions/:id/complete', requirePermission('lesson.log'), completeSession)
router.post('/sessions/:id/missed', requirePermission('lesson.log'), markSessionMissed)
// Oversight closes an overdue live class (no lesson.log needed) — tutor logs later.
router.post('/sessions/:id/force-complete', requirePermission('liveboard.view'), forceCompleteSession)
// Super-admin corrective reset: reverse an accidental complete/missed back to scheduled.
router.post('/sessions/:id/reset', requireRole('super_admin'), resetSession)
// QCI/super-admin: set any status/attendance value to correct a mislabelled class.
router.patch('/sessions/:id/status', requirePermission('schedule.session_status'), updateSessionStatus)
router.patch('/sessions/:id', requirePermission('schedule.manage'), updateSession)
router.delete('/sessions/:id', requirePermission('schedule.manage'), deleteSession)

// Live board
router.get('/live-board', requirePermission('liveboard.view'), getLiveBoard)
// A tutor's own live sessions (for the overrun reminder) — no liveboard.view needed
router.get('/my-live', requirePermission('schedule.read'), getMyLiveSessions)
router.get('/my-attendance', requirePermission('schedule.read'), getMyAttendanceSummary)
// A tutor's completed-but-unlogged sessions (auto/force completed) — prompt to log
router.get('/my-unlogged', requirePermission('schedule.read'), getMyUnloggedSessions)

export default router
