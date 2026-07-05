import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listSlots, createSlot, updateSlot, deleteSlot,
  listSessions, createSession, startSession, completeSession, markSessionMissed,
  getLiveBoard, getMyLiveSessions, generateSessionsForDate,
} from '../controllers/portalScheduleController.js'

const router = Router()
router.use(portalAuth)

// Class Slots
router.get('/slots', requirePermission('schedule.read'), listSlots)
router.post('/slots', requirePermission('schedule.manage'), createSlot)
router.patch('/slots/:id', requirePermission('schedule.manage'), updateSlot)
router.delete('/slots/:id', requirePermission('schedule.manage'), deleteSlot)

// Class Sessions
router.get('/sessions', requirePermission('schedule.read'), listSessions)
router.post('/sessions', requirePermission('schedule.manage'), createSession)
router.post('/sessions/generate', requirePermission('schedule.manage'), generateSessionsForDate)
router.post('/sessions/:id/start', requirePermission('lesson.log'), startSession)
router.post('/sessions/:id/complete', requirePermission('lesson.log'), completeSession)
router.post('/sessions/:id/missed', requirePermission('lesson.log'), markSessionMissed)

// Live board
router.get('/live-board', requirePermission('liveboard.view'), getLiveBoard)
// A tutor's own live sessions (for the overrun reminder) — no liveboard.view needed
router.get('/my-live', requirePermission('schedule.read'), getMyLiveSessions)

export default router
