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
import portalAdmissionRoutes from './routes/portalAdmissionRoutes.js'
import portalCurriculumRoutes from './routes/portalCurriculumRoutes.js'
import portalAssignmentRoutes from './routes/portalAssignmentRoutes.js'
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
import portalDashboardRoutes from './routes/portalDashboardRoutes.js'
import portalCertificateRoutes from './routes/portalCertificateRoutes.js'
import portalPaymentRoutes from './routes/portalPaymentRoutes.js'
import portalExpenseRoutes from './routes/portalExpenseRoutes.js'
import portalEmployeeAwardRoutes from './routes/portalEmployeeAwardRoutes.js'
import portalShiftConfigRoutes from './routes/portalShiftConfigRoutes.js'
import portalAdvanceRoutes from './routes/portalAdvanceRoutes.js'
import portalLeaveRoutes from './routes/portalLeaveRoutes.js'
import portalBadgeRoutes from './routes/portalBadgeRoutes.js'
import { initSocket } from './config/socket.js'
import requestLogger from './middleware/requestLogger.js'
import { startPaymentCleanupJob } from './utils/cleanupPayments.js'
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from './config/permissions.js'

const app = express()
const PORT = process.env.PORT || 5000

// Trust proxy (required for Render/reverse proxy + rate limiting)
app.set('trust proxy', 1)

// Database
await connectDB()

// Auto-sync system role permissions on startup
try {
  const Role = (await import('./models/Role.js')).default
  for (const key of Object.keys(DEFAULT_ROLE_PERMISSIONS)) {
    const perms = DEFAULT_ROLE_PERMISSIONS[key]
    const role = await Role.findOne({ key })
    if (role && role.permissions.length !== perms.length) {
      role.permissions = perms
      await role.save()
      console.log(`[sync] Updated ${key} role: ${perms.length} permissions`)
    }
  }
} catch (err) {
  console.error('Role permission sync error:', err.message)
}

// Security
app.use(helmet())
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }))
app.use(express.json({ limit: '5mb' }))

// Request logging (after body parsing, before routes)
app.use(requestLogger)

// Rate limiting (JSON responses for frontend compatibility)
const rl = (max) => rateLimit({ windowMs: 15 * 60 * 1000, max, handler: (req, res) => res.status(429).json({ error: 'Too many requests. Please try again later.' }) })
app.use('/api/auth', rl(100))
app.use('/api/payments/initiate', rl(50))
app.use('/api/enrollments', rl(100))
app.use('/api/subscribers/subscribe', rl(50))
app.use('/api/payment-links/t', rl(60))
app.use('/api/discount-codes/validate', rl(100))
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

// Portal routes
app.use('/api/portal/auth', portalAuthRoutes)
app.use('/api/portal/users', portalUserRoutes)
app.use('/api/portal/roles', portalRoleRoutes)
app.use('/api/portal/students', portalStudentRoutes)
app.use('/api/portal/tutors', portalTutorRoutes)
app.use('/api/portal/admissions', portalAdmissionRoutes)
app.use('/api/portal/curriculum', portalCurriculumRoutes)
app.use('/api/portal/assignments', portalAssignmentRoutes)
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
app.use('/api/portal/dashboard', portalDashboardRoutes)
app.use('/api/portal/certificates', portalCertificateRoutes)
app.use('/api/portal/billing', portalPaymentRoutes)
app.use('/api/portal/expenses', portalExpenseRoutes)
app.use('/api/portal/awards', portalEmployeeAwardRoutes)
app.use('/api/portal/shift-config', portalShiftConfigRoutes)
app.use('/api/portal/advances', portalAdvanceRoutes)
app.use('/api/portal/leaves', portalLeaveRoutes)
app.use('/api/portal/badges', portalBadgeRoutes)

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
})
