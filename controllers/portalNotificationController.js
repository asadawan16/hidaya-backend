import Notification from '../models/Notification.js'
import { emitToUser } from '../config/socket.js'
import { registerDevice, sendPushToUser, unregisterDevice } from '../services/push.js'

export async function listNotifications(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    // `limit=all` returns every matching record (used by the "Show All" page size).
    const unlimited = req.query.limit === 'all'
    const lim = unlimited ? 0 : Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { unreadOnly, type } = req.query

    const filter = { userId: req.userId }
    if (unreadOnly === 'true') filter.readAt = null
    if (type) filter.type = type // server-side category (tab) filter

    const total = await Notification.countDocuments(filter)
    const unreadCount = await Notification.countDocuments({ userId: req.userId, readAt: null })
    const pages = unlimited ? 1 : (Math.ceil(total / lim) || 1)

    let query = Notification.find(filter).sort({ createdAt: -1 })
    if (!unlimited) query = query.skip((pg - 1) * lim).limit(lim)
    const records = await query.lean()

    res.json({ records, total, page: unlimited ? 1 : pg, pages, unreadCount })
  } catch (err) {
    console.error('List notifications error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function markRead(req, res) {
  try {
    const { ids } = req.body
    if (ids && Array.isArray(ids)) {
      await Notification.updateMany(
        { _id: { $in: ids }, userId: req.userId, readAt: null },
        { readAt: new Date() }
      )
    } else {
      // Mark all as read
      await Notification.updateMany(
        { userId: req.userId, readAt: null },
        { readAt: new Date() }
      )
    }
    res.json({ message: 'Marked as read' })
  } catch (err) {
    console.error('Mark read error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteNotifications(req, res) {
  try {
    const { ids, all, type } = req.body
    // Explicit id list → delete just those.
    if (ids && Array.isArray(ids) && ids.length > 0) {
      const { deletedCount } = await Notification.deleteMany({ _id: { $in: ids }, userId: req.userId })
      return res.json({ message: 'Deleted', deleted: deletedCount })
    }
    // Category-wide delete (ignores pagination). Requires an explicit `all: true`
    // opt-in so a stray empty body can never wipe the whole inbox. Scoped to the
    // logged-in user; optional `type` narrows it to one tab/category.
    if (all === true) {
      const filter = { userId: req.userId }
      if (type) filter.type = type
      const { deletedCount } = await Notification.deleteMany(filter)
      return res.json({ message: 'Deleted', deleted: deletedCount })
    }
    res.json({ message: 'Deleted', deleted: 0 })
  } catch (err) {
    console.error('Delete notifications error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function markUnread(req, res) {
  try {
    const { ids } = req.body
    if (ids && Array.isArray(ids)) {
      await Notification.updateMany(
        { _id: { $in: ids }, userId: req.userId },
        { readAt: null }
      )
    }
    res.json({ message: 'Marked as unread' })
  } catch (err) {
    console.error('Mark unread error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Helper to create and push a notification.
// Never throws — a notification failure must not fail the parent action.
export async function createNotification({ userId, type, title, body, payload }) {
  try {
    if (!userId) return null
    const notif = await Notification.create({ userId, type, title, body, payload })
    emitToUser(userId.toString(), 'notification', notif)
    // Fire-and-forget mobile push (never awaited into the parent action).
    sendPushToUser(userId, { title, body, data: { type, ...(payload || {}) } })
    return notif
  } catch (err) {
    console.error('Create notification failed:', err.message)
    return null
  }
}

// ─── Mobile push device registration ───

export async function registerDeviceHandler(req, res) {
  try {
    const { token, platform, deviceId } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token required' })
    await registerDevice(req.userId, { token, platform, deviceId })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not register device' })
  }
}

export async function unregisterDeviceHandler(req, res) {
  try {
    const { token } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token required' })
    await unregisterDevice(req.userId, token)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
}

// Notify every active user holding any of the given role keys. Guarded.
export async function notifyRoles(roleKeys, { type, title, body, payload }) {
  try {
    const { default: User } = await import('../models/User.js')
    const { default: Role } = await import('../models/Role.js')
    const roles = await Role.find({ key: { $in: roleKeys } }).select('_id').lean()
    if (!roles.length) return
    const users = await User.find({ status: 'active', roles: { $in: roles.map(r => r._id) } })
      .select('_id').lean()
    for (const u of users) {
      await createNotification({ userId: u._id, type, title, body, payload })
    }
  } catch (err) {
    console.error('Notify roles failed:', err.message)
  }
}
