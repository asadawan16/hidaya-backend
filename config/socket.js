import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'

let io = null

// Presence — userId -> live socket count
const onlineCounts = new Map()

export function getOnlineUserIds() {
  return [...onlineCounts.keys()]
}

export function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL,
      credentials: true,
    },
    path: '/socket.io',
  })

  // Portal namespace
  const portal = io.of('/portal')

  portal.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
      if (!token) return next(new Error('Authentication required'))

      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      if (decoded.type !== 'portal') return next(new Error('Invalid token type'))

      const user = await User.findById(decoded.id).populate('roles').select('-password').lean()
      if (!user || user.status !== 'active') return next(new Error('User not found or inactive'))

      socket.userId = user._id.toString()
      socket.user = user
      socket.userRoles = user.roles.map(r => r.key)
      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  portal.on('connection', (socket) => {
    // Join personal room
    socket.join(`user:${socket.userId}`)

    // Join role rooms
    for (const role of socket.userRoles) {
      socket.join(`role:${role}`)
    }

    // Join live-board room if user has permission
    const perms = new Set()
    for (const role of socket.user.roles) {
      for (const p of role.permissions || []) perms.add(p)
    }
    if (perms.has('liveboard.view')) {
      socket.join('live-board')
    }

    // ── Presence ──
    const wasOffline = !onlineCounts.has(socket.userId)
    onlineCounts.set(socket.userId, (onlineCounts.get(socket.userId) || 0) + 1)
    if (wasOffline) portal.emit('presence_update', { userId: socket.userId, online: true })
    // Bootstrap the connecting client with the current online set
    socket.emit('presence_state', getOnlineUserIds())

    // ── Chat thread rooms (typing indicators scoped per conversation) ──
    socket.on('join_thread', async (threadId) => {
      try {
        if (!threadId) return
        const { default: ChatThread } = await import('../models/ChatThread.js')
        const thread = await ChatThread.findById(threadId).select('participants').lean()
        if (thread && thread.participants.some(p => p.toString() === socket.userId)) {
          socket.join(`thread:${threadId}`)
        }
      } catch { /* ignore */ }
    })
    socket.on('leave_thread', (threadId) => {
      if (threadId) socket.leave(`thread:${threadId}`)
    })

    // ── Typing indicators ──
    socket.on('typing', ({ threadId, isTyping }) => {
      if (!threadId) return
      socket.to(`thread:${threadId}`).emit('typing', {
        threadId,
        userId: socket.userId,
        displayName: socket.user.displayName || socket.user.email || 'Someone',
        isTyping: !!isTyping,
      })
    })

    socket.on('disconnect', () => {
      const count = (onlineCounts.get(socket.userId) || 1) - 1
      if (count <= 0) {
        onlineCounts.delete(socket.userId)
        portal.emit('presence_update', { userId: socket.userId, online: false })
      } else {
        onlineCounts.set(socket.userId, count)
      }
    })
  })

  return io
}

export function getIO() {
  return io
}

export function getPortalNamespace() {
  return io?.of('/portal')
}

// Emit to a specific user
export function emitToUser(userId, event, data) {
  const portal = getPortalNamespace()
  if (portal) portal.to(`user:${userId}`).emit(event, data)
}

// Emit to all users with a specific role
export function emitToRole(roleKey, event, data) {
  const portal = getPortalNamespace()
  if (portal) portal.to(`role:${roleKey}`).emit(event, data)
}

// Emit to every connected portal user
export function emitToAll(event, data) {
  const portal = getPortalNamespace()
  if (portal) portal.emit(event, data)
}

// Emit to all connected portal users EXCEPT students (staff-only broadcasts,
// e.g. demo-trial announcements). Students join the `role:student` room on
// connect, so we exclude that room.
export function emitToStaff(event, data) {
  const portal = getPortalNamespace()
  if (portal) portal.except('role:student').emit(event, data)
}

// Emit to live-board watchers
export function emitToLiveBoard(event, data) {
  const portal = getPortalNamespace()
  if (portal) portal.to('live-board').emit(event, data)
}
