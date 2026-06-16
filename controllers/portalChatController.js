import ChatThread from '../models/ChatThread.js'
import Message from '../models/Message.js'
import User from '../models/User.js'
import { emitToUser } from '../config/socket.js'
import { createNotification } from './portalNotificationController.js'

// ─── Threads / Channels ───

export async function listThreads(req, res) {
  try {
    const { type, search } = req.query
    const filter = { participants: req.userId, archived: { $ne: true } }
    if (type) filter.type = type
    if (search) filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }

    const threads = await ChatThread.find(filter)
      .populate('participants', 'displayName email avatar roles')
      .populate('lastMessageSenderId', 'displayName')
      .sort({ lastMessageAt: -1 })
      .limit(50)
      .lean()

    // Batch unread counts
    const threadIds = threads.map(t => t._id)
    const unreadCounts = await Message.aggregate([
      { $match: { threadId: { $in: threadIds }, senderId: { $ne: req.userId }, deleted: { $ne: true }, 'readBy.userId': { $ne: req.userId } } },
      { $group: { _id: '$threadId', count: { $sum: 1 } } },
    ])
    const unreadMap = {}
    unreadCounts.forEach(u => { unreadMap[u._id.toString()] = u.count })

    const enriched = threads.map(t => ({ ...t, unreadCount: unreadMap[t._id.toString()] || 0 }))
    res.json(enriched)
  } catch (err) {
    console.error('List threads error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createChannel(req, res) {
  try {
    const { name, description, label, labelColor, participantIds } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Channel name is required' })

    const allParticipants = [...new Set([req.userId.toString(), ...(participantIds || [])])]

    const channel = await ChatThread.create({
      type: 'channel',
      name: name.trim(),
      description: description?.trim() || '',
      label: label || '',
      labelColor: labelColor || '',
      createdBy: req.userId,
      participants: allParticipants,
    })

    const populated = await ChatThread.findById(channel._id)
      .populate('participants', 'displayName email avatar roles')
      .lean()

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create channel error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateChannel(req, res) {
  try {
    const thread = await ChatThread.findById(req.params.id)
    if (!thread || thread.type !== 'channel') return res.status(404).json({ error: 'Channel not found' })

    const { name, description, label, labelColor, addParticipants, removeParticipants } = req.body
    if (name !== undefined) thread.name = name.trim()
    if (description !== undefined) thread.description = description.trim()
    if (label !== undefined) thread.label = label
    if (labelColor !== undefined) thread.labelColor = labelColor

    if (addParticipants?.length) {
      for (const id of addParticipants) {
        if (!thread.participants.some(p => p.toString() === id)) thread.participants.push(id)
      }
    }
    if (removeParticipants?.length) {
      thread.participants = thread.participants.filter(p => !removeParticipants.includes(p.toString()))
    }

    await thread.save()
    const populated = await ChatThread.findById(thread._id).populate('participants', 'displayName email avatar roles').lean()
    res.json(populated)
  } catch (err) {
    console.error('Update channel error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getOrCreateDM(req, res) {
  try {
    const { participantId } = req.body
    if (!participantId) return res.status(400).json({ error: 'participantId is required' })

    const participants = [req.userId.toString(), participantId].sort()
    let thread = await ChatThread.findOne({ type: 'dm', participants: { $all: participants, $size: 2 } })
      .populate('participants', 'displayName email avatar roles')

    if (!thread) {
      thread = await ChatThread.create({ type: 'dm', participants })
      thread = await ChatThread.findById(thread._id).populate('participants', 'displayName email avatar roles')
    }

    res.json(thread)
  } catch (err) {
    console.error('Get/create DM error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Messages ───

export async function getMessages(req, res) {
  try {
    const { threadId } = req.params
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50))
    const { parentId, search, starred, pinned } = req.query

    const thread = await ChatThread.findById(threadId)
    if (!thread || !thread.participants.some(p => p.toString() === req.userId.toString())) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const filter = { threadId, deleted: { $ne: true } }
    if (parentId) filter.parentId = parentId
    else filter.parentId = null // top-level messages only
    if (search) filter.$text = { $search: search }
    if (starred === 'true') filter.starredBy = req.userId
    if (pinned === 'true') filter.pinned = true

    const total = await Message.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1

    const messages = await Message.find(filter)
      .populate('senderId', 'displayName email avatar')
      .populate('mentions.userId', 'displayName avatar')
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean()

    // Mark as read
    await Message.updateMany(
      { threadId, senderId: { $ne: req.userId }, 'readBy.userId': { $ne: req.userId } },
      { $push: { readBy: { userId: req.userId, readAt: new Date() } } }
    )

    res.json({ messages: messages.reverse(), total, page: pg, pages })
  } catch (err) {
    console.error('Get messages error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getThreadReplies(req, res) {
  try {
    const { messageId } = req.params
    const replies = await Message.find({ parentId: messageId, deleted: { $ne: true } })
      .populate('senderId', 'displayName email avatar')
      .sort({ createdAt: 1 })
      .limit(100)
      .lean()
    res.json(replies)
  } catch (err) {
    console.error('Get replies error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function sendMessage(req, res) {
  try {
    const { threadId } = req.params
    const { body, bodyHtml, format, attachments, mentions, parentId } = req.body
    if (!body?.trim()) return res.status(400).json({ error: 'Message body is required' })

    const thread = await ChatThread.findById(threadId)
    if (!thread || !thread.participants.some(p => p.toString() === req.userId.toString())) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const message = await Message.create({
      threadId,
      senderId: req.userId,
      body: body.trim(),
      bodyHtml: bodyHtml || '',
      format: format || 'plain',
      attachments: attachments || [],
      mentions: mentions || [],
      parentId: parentId || null,
      readBy: [{ userId: req.userId, readAt: new Date() }],
    })

    // Update thread
    thread.lastMessageAt = new Date()
    thread.lastMessagePreview = body.trim().slice(0, 100)
    thread.lastMessageSenderId = req.userId
    await thread.save()

    // Update parent reply count
    if (parentId) {
      await Message.findByIdAndUpdate(parentId, { $inc: { replyCount: 1 } })
    }

    const populated = await Message.findById(message._id)
      .populate('senderId', 'displayName email avatar')
      .populate('mentions.userId', 'displayName avatar')
      .lean()

    // Notify participants via Socket.io
    for (const pid of thread.participants) {
      if (pid.toString() !== req.userId.toString()) {
        emitToUser(pid.toString(), 'new_message', { threadId, message: populated })
      }
    }

    // Notify mentioned users
    if (mentions?.length) {
      const sender = await User.findById(req.userId).select('displayName').lean()
      for (const m of mentions) {
        if (m.userId.toString() !== req.userId.toString()) {
          await createNotification({
            userId: m.userId,
            type: 'chat',
            title: `${sender?.displayName || 'Someone'} mentioned you`,
            body: body.slice(0, 80),
            payload: { threadId, messageId: message._id },
          })
        }
      }
    }

    res.status(201).json(populated)
  } catch (err) {
    console.error('Send message error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function editMessage(req, res) {
  try {
    const msg = await Message.findById(req.params.messageId)
    if (!msg) return res.status(404).json({ error: 'Message not found' })
    if (msg.senderId.toString() !== req.userId.toString()) return res.status(403).json({ error: 'Can only edit own messages' })

    msg.body = req.body.body?.trim() || msg.body
    msg.bodyHtml = req.body.bodyHtml || msg.bodyHtml
    msg.edited = true
    msg.editedAt = new Date()
    await msg.save()

    res.json(msg)
  } catch (err) {
    console.error('Edit message error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteMessage(req, res) {
  try {
    const msg = await Message.findById(req.params.messageId)
    if (!msg) return res.status(404).json({ error: 'Message not found' })
    if (msg.senderId.toString() !== req.userId.toString()) return res.status(403).json({ error: 'Can only delete own messages' })

    msg.deleted = true
    msg.body = 'This message was deleted'
    msg.attachments = []
    await msg.save()

    res.json({ message: 'Deleted' })
  } catch (err) {
    console.error('Delete message error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Star / Pin ───

export async function toggleStar(req, res) {
  try {
    const msg = await Message.findById(req.params.messageId)
    if (!msg) return res.status(404).json({ error: 'Message not found' })

    const idx = msg.starredBy.findIndex(id => id.toString() === req.userId.toString())
    if (idx >= 0) msg.starredBy.splice(idx, 1)
    else msg.starredBy.push(req.userId)
    await msg.save()

    res.json({ starred: idx < 0 })
  } catch (err) {
    console.error('Toggle star error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function togglePin(req, res) {
  try {
    const msg = await Message.findById(req.params.messageId)
    if (!msg) return res.status(404).json({ error: 'Message not found' })

    msg.pinned = !msg.pinned
    if (msg.pinned) { msg.pinnedBy = req.userId; msg.pinnedAt = new Date() }
    else { msg.pinnedBy = null; msg.pinnedAt = null }
    await msg.save()

    // Update thread pinned messages
    if (msg.pinned) {
      await ChatThread.findByIdAndUpdate(msg.threadId, { $addToSet: { pinnedMessages: msg._id } })
    } else {
      await ChatThread.findByIdAndUpdate(msg.threadId, { $pull: { pinnedMessages: msg._id } })
    }

    res.json({ pinned: msg.pinned })
  } catch (err) {
    console.error('Toggle pin error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Search messages ───

export async function searchMessages(req, res) {
  try {
    const { q, threadId } = req.query
    if (!q) return res.json([])

    const filter = { deleted: { $ne: true }, $text: { $search: q } }
    if (threadId) filter.threadId = threadId

    // Only in threads user participates in
    const userThreads = await ChatThread.find({ participants: req.userId }).select('_id').lean()
    if (!threadId) filter.threadId = { $in: userThreads.map(t => t._id) }

    const results = await Message.find(filter)
      .populate('senderId', 'displayName avatar')
      .populate('threadId', 'name type')
      .sort({ createdAt: -1 })
      .limit(30)
      .lean()

    res.json(results)
  } catch (err) {
    console.error('Search messages error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Mentionable users ───

export async function getMentionableUsers(req, res) {
  try {
    const { search } = req.query
    const filter = { status: 'active' }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ displayName: regex }, { email: regex }]
    }

    const users = await User.find(filter)
      .populate('roles', 'key name')
      .select('displayName email avatar roles')
      .limit(20)
      .lean()

    res.json(users)
  } catch (err) {
    console.error('Get mentionable users error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
