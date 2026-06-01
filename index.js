import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import connectDB from './config/db.js'
import authRoutes from './routes/authRoutes.js'
import paymentRoutes from './routes/paymentRoutes.js'
import enrollmentRoutes from './routes/enrollmentRoutes.js'

const app = express()
const PORT = process.env.PORT || 5000

// Database
await connectDB()

// Security
app.use(helmet())
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }))
app.use(express.json({ limit: '1mb' }))

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }))
app.use('/api/payments/initiate', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }))
app.use('/api/enrollments', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }))

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/payments', paymentRoutes)
app.use('/api/enrollments', enrollmentRoutes)

// Health
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }))

app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
