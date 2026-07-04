import Notification from '../models/Notification.js'
import { emitToUser } from '../config/socket.js'

export async function listNotifications(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20))
    const { unreadOnly } = req.query

    const filter = { userId: req.userId }
    if (unreadOnly === 'true') filter.readAt = null

    const total = await Notification.countDocuments(filter)
    const unreadCount = await Notification.countDocuments({ userId: req.userId, readAt: null })
    const pages = Math.ceil(total / lim) || 1

    const records = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: pg, pages, unreadCount })
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
    const { ids } = req.body
    if (ids && Array.isArray(ids) && ids.length > 0) {
      await Notification.deleteMany({ _id: { $in: ids }, userId: req.userId })
    }
    res.json({ message: 'Deleted' })
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

// Helper to create and push a notification
export async function createNotification({ userId, type, title, body, payload }) {
  const notif = await Notification.create({ userId, type, title, body, payload })
  emitToUser(userId.toString(), 'notification', notif)
  return notif
}
