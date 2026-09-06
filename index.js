import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import connectDB from './config/db.js'
import authRoutes from './routes/authRoutes.js'
import paymentRoutes from './routes/paymentRoutes.js'
import enrollmentRoutes from './routes/enrollmentRoutes.js'
import subscriberRoutes from './routes/subscriberRoutes.js'
import blogRoutes from './routes/blogRoutes.js'
import uploadRoutes from './routes/uploadRoutes.js'
import paymentLinkRoutes from './routes/paymentLinkRoutes.js'
import planRoutes from './routes/planRoutes.js'
import studentRoutes from './routes/studentRoutes.js'
import exportRoutes from './routes/exportRoutes.js'
import discountCodeRoutes from './routes/discountCodeRoutes.js'
import logRoutes from './routes/logRoutes.js'
import portalAuthRoutes from './routes/portalAuthRoutes.js'
import portalUserRoutes from './routes/portalUserRoutes.js'
import portalRoleRoutes from './routes/portalRoleRoutes.js'
import portalStudentRoutes from './routes/portalStudentRoutes.js'
import portalTutorRoutes from './routes/portalTutorRoutes.js'
import portalStaffRoutes from './routes/portalStaffRoutes.js'
import portalAdmissionRoutes from './routes/portalAdmissionRoutes.js'
import portalCurriculumRoutes from './routes/portalCurriculumRoutes.js'
import portalAssignmentRoutes from './routes/portalAssignmentRoutes.js'
import portalTutorChangeRoutes from './routes/portalTutorChangeRoutes.js'
import portalScheduleRoutes from './routes/portalScheduleRoutes.js'
import portalAttendanceRoutes from './routes/portalAttendanceRoutes.js'
import portalLessonRoutes from './routes/portalLessonRoutes.js'
import portalChatRoutes from './routes/portalChatRoutes.js'
import portalNotificationRoutes from './routes/portalNotificationRoutes.js'
import portalAssessmentRoutes from './routes/portalAssessmentRoutes.js'
import portalNoticeRoutes from './routes/portalNoticeRoutes.js'
import portalFinanceRoutes from './routes/portalFinanceRoutes.js'
import portalReportRoutes from './routes/portalReportRoutes.js'
import portalFamilyRoutes from './routes/portalFamilyRoutes.js'
import portalLeadsRoutes from './routes/portalLeadsRoutes.js'
import portalDemoRoutes from './routes/portalDemoRoutes.js'
import portalDashboardRoutes from './routes/portalDashboardRoutes.js'
import portalCertificateRoutes from './routes/portalCertificateRoutes.js'
import portalPaymentRoutes from './routes/portalPaymentRoutes.js'
import portalExpenseRoutes from './routes/portalExpenseRoutes.js'
import portalEmployeeAwardRoutes from './routes/portalEmployeeAwardRoutes.js'
import portalShiftConfigRoutes from './routes/portalShiftConfigRoutes.js'
import portalAdvanceRoutes from './routes/portalAdvanceRoutes.js'
import portalLeaveRoutes from './routes/portalLeaveRoutes.js'
import portalBadgeRoutes from './routes/portalBadgeRoutes.js'
import portalStudentProgressRoutes from './routes/portalStudentProgressRoutes.js'
import portalFeeRoutes from './routes/portalFeeRoutes.js'
import portalClassLinkRoutes from './routes/portalClassLinkRoutes.js'
import publicClassLinkRoutes from './routes/publicClassLinkRoutes.js'
import publicCheckoutRoutes from './routes/publicCheckoutRoutes.js'
import { stripeWebhook } from './controllers/stripeWebhookController.js'
import { isAllowedOrigin } from './config/sites.js'
import { initSocket } from './config/socket.js'
// import requestLogger from './middleware/requestLogger.js' // disabled 2026-08-02 — see app.use note below
import { startPaymentCleanupJob } from './utils/cleanupPayments.js'
import { runAutoSessionGeneration, autoCompleteOverrunSessions } from './controllers/portalScheduleController.js'
import { ALL_PERMISSIONS, RESTRICTION_PERMISSIONS } from './config/permissions.js'

const app = express()
const PORT = process.env.PORT || 5000

// Trust proxy (required for Render/reverse proxy + rate limiting)
app.set('trust proxy', 1)

// Database
await connectDB()

// Keep ONLY the super_admin role complete on startup. super_admin is the god-role
// and must gain any newly-added catalog permission so new features never lock it out.
// This is strictly ADDITIVE ($addToSet) and touches NO other role — permissions
// configured in the UI for admin, qci, coordinator, custom roles, etc. are NEVER
// reset on deploy. (Previously this block overwrote every system role with the code
// defaults, wiping client role customizations on each restart.)
//
// EXCEPTION: RESTRICTION permissions (e.g. lesson.log_only) invert the grant model —
// their presence removes access — so super_admin must NEVER hold them. We grant only
// the non-restriction catalog and actively pull any restriction perm back out (in case
// an older build synced the full catalog before this carve-out existed).
try {
  const Role = (await import('./models/Role.js')).default
  const GRANTABLE = ALL_PERMISSIONS.filter(p => !RESTRICTION_PERMISSIONS.includes(p))
  const sa = await Role.findOne({ key: 'super_admin' }).select('permissions').lean()
  if (sa) {
    const missing = GRANTABLE.filter(p => !sa.permissions.includes(p))
    if (missing.length > 0) {
      await Role.updateOne({ key: 'super_admin' }, { $addToSet: { permissions: { $each: GRANTABLE } } })
      console.log(`[sync] super_admin: added ${missing.length} new permission(s)`)
    }
    const restricted = RESTRICTION_PERMISSIONS.filter(p => sa.permissions.includes(p))
    if (restricted.length > 0) {
      await Role.updateOne({ key: 'super_admin' }, { $pull: { permissions: { $in: RESTRICTION_PERMISSIONS } } })
      console.log(`[sync] super_admin: removed ${restricted.length} restriction permission(s)`)
    }
  }
} catch (err) {
  console.error('Role permission sync error:', err.message)
}

// Security
app.use(helmet())

// CORS — a hardcoded allow-list (config/sites.js) rather than a single env var,
// because two front ends now talk to this API: hidaya.online and the
// qurantutornow.com ad site. Whatever FRONTEND_URL points at is allowed too, so
// preview deploys keep working. A disallowed origin simply gets no CORS headers
// (cb(null, false)) instead of a 500 from a thrown error.
app.use(cors({
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  credentials: true,
}))

// Stripe webhook — MUST be mounted before express.json(). The signature is
// computed over the exact bytes Stripe sent, so the handler needs the raw
// Buffer; a parsed-and-re-serialized body never verifies. Server-to-server,
// so it is deliberately outside CORS/auth and authenticated by signature only.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhook)

app.use(express.json({ limit: '5mb' }))

// Request logging DISABLED (2026-08-02): the per-request access logger wrote one
// Log document for every HTTP request (~51k/day, mostly frontend polling GETs),
// which filled the Atlas free tier. Business audit events are still recorded via
// utils/activityLogger.js. Re-enable below only if reduced to writes/errors.
// app.use(requestLogger)

// Rate limiting (JSON responses for frontend compatibility)
const rl = (max) => rateLimit({ windowMs: 15 * 60 * 1000, max, handler: (req, res) => res.status(429).json({ error: 'Too many requests. Please try again later.' }) })
app.use('/api/auth', rl(100))
app.use('/api/payments/initiate', rl(50))
app.use('/api/enrollments', rl(100))
app.use('/api/subscribers/subscribe', rl(50))
app.use('/api/payment-links/t', rl(60))
app.use('/api/discount-codes/validate', rl(100))
app.use('/api/class-links', rl(300))
// Satellite marketing sites (qurantutornow.com): price book + self-serve
// checkout + trial form. Generous enough for a shared office IP, tight enough
// that nobody can farm payment links.
app.use('/api/public', rl(60))
app.use('/api/portal/auth/forgot-password', rl(10))
app.use('/api/portal/auth/reset-password', rl(20))
app.use('/api/portal/auth', rl(100))

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/payments', paymentRoutes)
app.use('/api/enrollments', enrollmentRoutes)
app.use('/api/subscribers', subscriberRoutes)
app.use('/api/blogs', blogRoutes)
app.use('/api/uploads', uploadRoutes)
app.use('/api/payment-links', paymentLinkRoutes)
app.use('/api/plans', planRoutes)
app.use('/api/students', studentRoutes)
app.use('/api/export', exportRoutes)
app.use('/api/discount-codes', discountCodeRoutes)
app.use('/api/logs', logRoutes)
// Public (unauthenticated) — the shareable class-links board
app.use('/api/class-links', publicClassLinkRoutes)
// Public (unauthenticated) — satellite marketing sites (qurantutornow.com)
app.use('/api/public', publicCheckoutRoutes)

// Portal routes
app.use('/api/portal/auth', portalAuthRoutes)
app.use('/api/portal/users', portalUserRoutes)
app.use('/api/portal/roles', portalRoleRoutes)
app.use('/api/portal/students', portalStudentRoutes)
app.use('/api/portal/tutors', portalTutorRoutes)
app.use('/api/portal/staff', portalStaffRoutes)
app.use('/api/portal/admissions', portalAdmissionRoutes)
app.use('/api/portal/curriculum', portalCurriculumRoutes)
app.use('/api/portal/assignments', portalAssignmentRoutes)
app.use('/api/portal/tutor-change-requests', portalTutorChangeRoutes)
app.use('/api/portal/schedule', portalScheduleRoutes)
app.use('/api/portal/attendance', portalAttendanceRoutes)
app.use('/api/portal/lessons', portalLessonRoutes)
app.use('/api/portal/chat', portalChatRoutes)
app.use('/api/portal/notifications', portalNotificationRoutes)
app.use('/api/portal/assessments', portalAssessmentRoutes)
app.use('/api/portal/notices', portalNoticeRoutes)
app.use('/api/portal/finance', portalFinanceRoutes)
app.use('/api/portal/reports', portalReportRoutes)
app.use('/api/portal/families', portalFamilyRoutes)
app.use('/api/portal/leads', portalLeadsRoutes)
app.use('/api/portal/demos', portalDemoRoutes)
app.use('/api/portal/dashboard', portalDashboardRoutes)
app.use('/api/portal/certificates', portalCertificateRoutes)
app.use('/api/portal/billing', portalPaymentRoutes)
app.use('/api/portal/expenses', portalExpenseRoutes)
app.use('/api/portal/awards', portalEmployeeAwardRoutes)
app.use('/api/portal/shift-config', portalShiftConfigRoutes)
app.use('/api/portal/advances', portalAdvanceRoutes)
app.use('/api/portal/leaves', portalLeaveRoutes)
app.use('/api/portal/badges', portalBadgeRoutes)
app.use('/api/portal/student-progress', portalStudentProgressRoutes)
app.use('/api/portal/fees', portalFeeRoutes)
app.use('/api/portal/class-links', portalClassLinkRoutes)

// Health
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }))

// Create HTTP server
const server = createServer(app)

// Socket.io for portal real-time features
initSocket(server)

// Legacy WebSocket for admin export.
// noServer + manual routing: attaching ws directly to the server would register
// an upgrade listener that aborts every non-/ws/export upgrade — including all
// Socket.IO websocket handshakes.
const wss = new WebSocketServer({ noServer: true })
app.set('wss', wss)

server.on('upgrade', (req, socket, head) => {
  let pathname = ''
  try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname } catch { /* ignore */ }
  if (pathname === '/ws/export') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }
  // /socket.io upgrades are handled by Socket.IO's own listener
})

wss.on('connection', (ws, req) => {
  // Authenticate via token query param
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    if (!token) { ws.close(4001, 'Token required'); return }
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    ws._adminId = decoded.id
    ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket connected' }))
  } catch {
    ws.close(4003, 'Invalid token')
  }
})

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  startPaymentCleanupJob()

  // Auto-generate today's sessions from recurring slots (Asia/Karachi), if enabled.
  // Runs on startup and hourly; idempotent so re-runs never duplicate.
  runAutoSessionGeneration()
  setInterval(runAutoSessionGeneration, 60 * 60 * 1000)

  // Auto-complete classes left running past AUTO_COMPLETE_AFTER_MIN (50 min).
  // Runs on startup and every 5 min; notifies oversight + prompts tutors to log.
  autoCompleteOverrunSessions()
  setInterval(autoCompleteOverrunSessions, 5 * 60 * 1000)
})
