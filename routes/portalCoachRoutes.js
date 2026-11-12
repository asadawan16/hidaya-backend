import express, { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { portalAuth, requirePermission, requireAnyPermission } from '../middleware/portalAuth.js'
import { denyStudentAccounts } from '../middleware/studentScope.js'
import {
  getConfig, startSession, addTurn, finishSession, listMine, getSession, rescoreSession,
  listSessions, listPeople, getOverview, reviewSession, deleteSession, getSettings, updateSettings,
} from '../controllers/portalCoachController.js'
import {
  listScripts, createScript, updateScript, deleteScript, restoreScript, restoreBook, reorderScripts,
} from '../controllers/portalCoachScriptController.js'
import {
  getLevels, saveLevels, levelTeam, listPractisers, listAssignments, createAssignments, deleteAssignment,
} from '../controllers/portalCoachLevelController.js'

// English Coach — see controllers/portalCoachController.js for the flow.
const router = Router()
router.use(portalAuth, denyStudentAccounts)

router.param('id', (req, res, next, id) => {
  if (!/^[a-f\d]{24}$/i.test(id)) return res.status(404).json({ error: 'Practice call not found' })
  next()
})

// Per person, not per IP: a staff room shares one address. Each answer costs
// AI quota, so this caps a stuck retry loop rather than normal speaking pace.
const perUser = (max) => rateLimit({
  windowMs: 60_000,
  max,
  keyGenerator: (req) => String(req.userId),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'slow_down', error: 'Too many requests — please wait a moment.' },
})

// One recorded answer. Up to two minutes of compressed audio is well under 8 MB.
const audioBody = express.raw({ type: () => true, limit: '8mb' })

router.get('/config', requirePermission('coach.practice'), getConfig)
router.get('/sessions/mine', requirePermission('coach.practice'), listMine)
router.post('/sessions', requirePermission('coach.practice'), perUser(10), startSession)
router.post('/sessions/:id/turns', requirePermission('coach.practice'), perUser(20), audioBody, addTurn)
router.post('/sessions/:id/finish', requirePermission('coach.practice'), finishSession)
router.post('/sessions/:id/rescore', requireAnyPermission('coach.practice', 'coach.review'), perUser(10), rescoreSession)
router.get('/sessions/:id', requireAnyPermission('coach.practice', 'coach.review'), getSession)

router.get('/sessions', requirePermission('coach.review'), listSessions)
router.get('/people', requirePermission('coach.review'), listPeople)
router.get('/overview', requirePermission('coach.review'), getOverview)
router.patch('/sessions/:id/review', requirePermission('coach.review'), reviewSession)

router.delete('/sessions/:id', requirePermission('coach.manage'), deleteSession)
router.get('/settings', requirePermission('coach.manage'), getSettings)
router.put('/settings', requirePermission('coach.manage'), updateSettings)

// The Scripts tab: the word-for-word parts (controllers/portalCoachScriptController.js)
router.get('/scripts', requirePermission('coach.manage'), listScripts)
router.post('/scripts', requirePermission('coach.manage'), createScript)
router.put('/scripts/order', requirePermission('coach.manage'), reorderScripts)
router.post('/scripts/restore-book', requirePermission('coach.manage'), restoreBook)
router.put('/scripts/:scriptId', requirePermission('coach.manage'), updateScript)
router.delete('/scripts/:scriptId', requirePermission('coach.manage'), deleteScript)
router.post('/scripts/:scriptId/restore', requirePermission('coach.manage'), restoreScript)

// Levels and assigned tests (controllers/portalCoachLevelController.js)
router.get('/levels', requireAnyPermission('coach.manage', 'coach.review'), getLevels)
router.put('/levels', requirePermission('coach.manage'), saveLevels)
router.get('/levels/team', requirePermission('coach.review'), levelTeam)
router.get('/practisers', requirePermission('coach.review'), listPractisers)
router.get('/assignments', requirePermission('coach.review'), listAssignments)
router.post('/assignments', requirePermission('coach.review'), createAssignments)
router.delete('/assignments/:assignmentId', requirePermission('coach.review'), deleteAssignment)

export default router
