import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'

let io = null

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

    socket.on('disconnect', () => {
      // Cleanup handled automatically by socket.io
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

// Emit to live-board watchers
export function emitToLiveBoard(event, data) {
  const portal = getPortalNamespace()
  if (portal) portal.to('live-board').emit(event, data)
}
