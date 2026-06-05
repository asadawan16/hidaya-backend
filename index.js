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
import { startPaymentCleanupJob } from './utils/cleanupPayments.js'

const app = express()
const PORT = process.env.PORT || 5000

// Trust proxy (required for Render/reverse proxy + rate limiting)
app.set('trust proxy', 1)

// Database
await connectDB()

// Security
app.use(helmet())
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }))
app.use(express.json({ limit: '5mb' }))

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }))
app.use('/api/payments/initiate', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }))
app.use('/api/enrollments', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }))
app.use('/api/subscribers/subscribe', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }))
app.use('/api/payment-links/t', rateLimit({ windowMs: 15 * 60 * 1000, max: 15 }))
app.use('/api/discount-codes/validate', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }))

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

// Health
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }))

// Create HTTP server and WebSocket server
const server = createServer(app)

const wss = new WebSocketServer({ server, path: '/ws/export' })
app.set('wss', wss)

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
