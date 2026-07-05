import ChatThread from '../models/ChatThread.js'
import Message from '../models/Message.js'
import User from '../models/User.js'
import Student from '../models/Student.js'
import { emitToUser, getOnlineUserIds } from '../config/socket.js'
import { createNotification } from './portalNotificationController.js'

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g
const FOREVER = new Date('9999-01-01')

function extractUrls(text) {
  return [...new Set((text || '').match(URL_REGEX) || [])].slice(0, 20)
}

function isMember(thread, userId) {
  return thread.participants.some(p => (p._id || p).toString() === userId.toString())
}

function roleOf(thread, userId) {
  const entry = (thread.memberRoles || []).find(r => r.userId.toString() === userId.toString())
  if (entry) return entry.role
  if (thread.createdBy && thread.createdBy.toString() === userId.toString()) return 'owner'
  return 'member'
}

function isChatModerator(req) {
  const keys = (req.user?.roles || []).map(r => r.key)
  return keys.includes('super_admin') || keys.includes('admin')
}

function emitToParticipants(thread, excludeId, event, data) {
  for (const pid of thread.participants) {
    const id = (pid._id || pid).toString()
    if (!excludeId || id !== excludeId.toString()) emitToUser(id, event, data)
  }
}

/** Flatten the calling user's prefs onto a lean thread object. */
function withMyPrefs(thread, userId) {
  const prefs = (thread.userPrefs || []).find(p => p.userId.toString() === userId.toString()) || {}
  const muted = prefs.mutedUntil && new Date(prefs.mutedUntil) > new Date()
  const { userPrefs: _drop, ...rest } = thread
  return {
    ...rest,
    myPrefs: {
      pinned: !!prefs.pinned,
      favourite: !!prefs.favourite,
      muted: !!muted,
      mutedUntil: muted ? prefs.mutedUntil : null,
      label: prefs.label || '',
      labelColor: prefs.labelColor || '',
      background: prefs.background || '',
    },
  }
}

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

    const enriched = threads.map(t => ({
      ...withMyPrefs(t, req.userId),
      unreadCount: unreadMap[t._id.toString()] || 0,
    }))
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
      memberRoles: allParticipants.map(id => ({
        userId: id,
        role: id === req.userId.toString() ? 'owner' : 'member',
      })),
    })

    const populated = await ChatThread.findById(channel._id)
      .populate('participants', 'displayName email avatar roles')
      .lean()

    emitToParticipants(populated, req.userId, 'thread_updated', { threadId: channel._id })
    res.status(201).json(withMyPrefs(populated, req.userId))
  } catch (err) {
    console.error('Create channel error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateChannel(req, res) {
  try {
    const thread = await ChatThread.findById(req.params.id)
    if (!thread || thread.type !== 'channel') return res.status(404).json({ error: 'Channel not found' })
    if (!isMember(thread, req.userId)) return res.status(403).json({ error: 'Access denied' })

    const myRole = roleOf(thread, req.userId)
    const canManage = myRole === 'owner' || myRole === 'admin' || isChatModerator(req)

    const { name, description, label, labelColor, addParticipants, removeParticipants } = req.body
    if (name !== undefined && name.trim() !== thread.name) {
      if (myRole !== 'owner' && !isChatModerator(req)) return res.status(403).json({ error: 'Only the channel owner can rename' })
      thread.name = name.trim()
    }
    if (description !== undefined) {
      if (!canManage) return res.status(403).json({ error: 'No permission to edit channel' })
      thread.description = description.trim()
    }
    if (label !== undefined) { if (canManage) thread.label = label }
    if (labelColor !== undefined) { if (canManage) thread.labelColor = labelColor }

    if (addParticipants?.length) {
      if (!canManage) return res.status(403).json({ error: 'No permission to add members' })
      for (const id of addParticipants) {
        if (!thread.participants.some(p => p.toString() === id)) {
          thread.participants.push(id)
          thread.memberRoles.push({ userId: id, role: 'member' })
        }
      }
    }
    if (removeParticipants?.length) {
      if (!canManage) return res.status(403).json({ error: 'No permission to remove members' })
      const removable = removeParticipants.filter(id => roleOf(thread, id) !== 'owner')
      thread.participants = thread.participants.filter(p => !removable.includes(p.toString()))
      thread.memberRoles = thread.memberRoles.filter(r => !removable.includes(r.userId.toString()))
    }

    await thread.save()
    const populated = await ChatThread.findById(thread._id).populate('participants', 'displayName email avatar roles').lean()
    emitToParticipants(populated, null, 'thread_updated', { threadId: thread._id })
    res.json(withMyPrefs(populated, req.userId))
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
      .populate('reactions.users', 'displayName')
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
    const { body, bodyHtml, format, mentions, parentId, mentionsAll, mentionsHere, studentTags, quotedMessage } = req.body
    if (!body?.trim()) return res.status(400).json({ error: 'Message body is required' })

    const thread = await ChatThread.findById(threadId)
    if (!thread || !thread.participants.some(p => p.toString() === req.userId.toString())) {
      return res.status(403).json({ error: 'Access denied' })
    }
    if (thread.archived) return res.status(400).json({ error: 'This channel is archived' })

    const message = await Message.create({
      threadId,
      senderId: req.userId,
      body: body.trim(),
      bodyHtml: bodyHtml || '',
      format: format || 'plain',
      mentions: mentions || [],
      mentionsAll: !!mentionsAll,
      mentionsHere: !!mentionsHere,
      studentTags: (studentTags || []).slice(0, 10),
      quotedMessage: quotedMessage?.messageId ? {
        messageId: quotedMessage.messageId,
        senderName: (quotedMessage.senderName || '').slice(0, 80),
        body: (quotedMessage.body || '').slice(0, 200),
      } : undefined,
      linkUrls: extractUrls(body),
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

    // Notify mentioned users (@user, @all = everyone, @here = online members)
    const sender = await User.findById(req.userId).select('displayName').lean()
    const senderName = sender?.displayName || 'Someone'
    const notifyIds = new Set((mentions || []).map(m => m.userId.toString()))
    if (mentionsAll) thread.participants.forEach(p => notifyIds.add(p.toString()))
    if (mentionsHere) {
      const online = new Set(getOnlineUserIds())
      thread.participants.forEach(p => { if (online.has(p.toString())) notifyIds.add(p.toString()) })
    }
    notifyIds.delete(req.userId.toString())
    for (const uid of notifyIds) {
      await createNotification({
        userId: uid,
        type: 'chat_mention',
        title: `${senderName} mentioned you`,
        body: body.slice(0, 80),
        payload: { threadId, messageId: message._id },
      })
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
    msg.linkUrls = extractUrls(msg.body)
    msg.edited = true
    msg.editedAt = new Date()
    await msg.save()

    const thread = await ChatThread.findById(msg.threadId).select('participants').lean()
    if (thread) emitToParticipants(thread, req.userId, 'message_updated', { threadId: msg.threadId, message: msg.toObject() })

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
    const mine = msg.senderId.toString() === req.userId.toString()
    if (!mine && !isChatModerator(req)) return res.status(403).json({ error: 'Can only delete own messages' })

    msg.deleted = true
    msg.body = 'This message was deleted'
    msg.attachments = []
    msg.reactions = []
    msg.linkUrls = []
    await msg.save()

    const thread = await ChatThread.findById(msg.threadId).select('participants').lean()
    if (thread) emitToParticipants(thread, req.userId, 'message_deleted', { threadId: msg.threadId, messageId: msg._id })

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

    // Membership check — only participants of the thread may pin/unpin
    const pinThread = await ChatThread.findById(msg.threadId).select('participants').lean()
    if (!pinThread || !isMember(pinThread, req.userId)) return res.status(403).json({ error: 'Access denied' })

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

    emitToParticipants(pinThread, req.userId, 'message_updated', { threadId: msg.threadId, message: msg.toObject() })
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

// ─── Reactions ───

export async function toggleReaction(req, res) {
  try {
    const { emoji } = req.body
    if (!emoji || emoji.length > 16) return res.status(400).json({ error: 'emoji is required' })

    const msg = await Message.findById(req.params.messageId)
    if (!msg || msg.deleted) return res.status(404).json({ error: 'Message not found' })

    const thread = await ChatThread.findById(msg.threadId).select('participants').lean()
    if (!thread || !isMember(thread, req.userId)) return res.status(403).json({ error: 'Access denied' })

    let entry = msg.reactions.find(r => r.emoji === emoji)
    if (!entry) {
      msg.reactions.push({ emoji, users: [req.userId] })
    } else {
      const idx = entry.users.findIndex(u => u.toString() === req.userId.toString())
      if (idx >= 0) entry.users.splice(idx, 1)
      else entry.users.push(req.userId)
      if (entry.users.length === 0) msg.reactions = msg.reactions.filter(r => r.emoji !== emoji)
    }
    await msg.save()

    const populated = await Message.findById(msg._id)
      .populate('reactions.users', 'displayName')
      .lean()

    emitToParticipants(thread, req.userId, 'message_reaction', {
      threadId: msg.threadId, messageId: msg._id, reactions: populated.reactions,
    })
    res.json({ reactions: populated.reactions })
  } catch (err) {
    console.error('Toggle reaction error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Forward ───

export async function forwardMessage(req, res) {
  try {
    const { targetThreadId } = req.body
    if (!targetThreadId) return res.status(400).json({ error: 'targetThreadId is required' })

    const src = await Message.findById(req.params.messageId).populate('senderId', 'displayName email').lean()
    if (!src || src.deleted) return res.status(404).json({ error: 'Message not found' })

    const [srcThread, target] = await Promise.all([
      ChatThread.findById(src.threadId).select('participants name type').lean(),
      ChatThread.findById(targetThreadId),
    ])
    if (!srcThread || !isMember(srcThread, req.userId)) return res.status(403).json({ error: 'Access denied' })
    if (!target || !isMember(target, req.userId)) return res.status(403).json({ error: 'No access to target conversation' })
    if (target.archived) return res.status(400).json({ error: 'Target channel is archived' })

    const message = await Message.create({
      threadId: target._id,
      senderId: req.userId,
      body: src.body,
      bodyHtml: src.bodyHtml || '',
      format: src.format || 'plain',
      studentTags: src.studentTags || [],
      linkUrls: src.linkUrls || [],
      forwardedFrom: {
        threadId: src.threadId,
        threadName: srcThread.type === 'channel' ? srcThread.name : 'Direct message',
        senderName: src.senderId?.displayName || src.senderId?.email || 'Unknown',
      },
      readBy: [{ userId: req.userId, readAt: new Date() }],
    })

    target.lastMessageAt = new Date()
    target.lastMessagePreview = src.body.slice(0, 100)
    target.lastMessageSenderId = req.userId
    await target.save()

    const populated = await Message.findById(message._id)
      .populate('senderId', 'displayName email avatar')
      .lean()
    emitToParticipants(target, req.userId, 'new_message', { threadId: target._id, message: populated })
    res.status(201).json(populated)
  } catch (err) {
    console.error('Forward message error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Channel membership: leave / archive / roles ───

export async function leaveChannel(req, res) {
  try {
    const thread = await ChatThread.findById(req.params.id)
    if (!thread || thread.type !== 'channel') return res.status(404).json({ error: 'Channel not found' })
    if (!isMember(thread, req.userId)) return res.status(403).json({ error: 'Not a member' })

    const uid = req.userId.toString()
    thread.participants = thread.participants.filter(p => p.toString() !== uid)
    thread.memberRoles = (thread.memberRoles || []).filter(r => r.userId.toString() !== uid)

    // Owner leaving — transfer ownership to first admin, else first member
    if (roleOf(thread, uid) === 'owner' || thread.createdBy?.toString() === uid) {
      const next = (thread.memberRoles || []).find(r => r.role === 'admin') || (thread.memberRoles || [])[0]
      if (next) next.role = 'owner'
    }

    await thread.save()
    emitToParticipants(thread, null, 'thread_updated', { threadId: thread._id })
    res.json({ message: 'Left channel' })
  } catch (err) {
    console.error('Leave channel error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function archiveChannel(req, res) {
  try {
    const thread = await ChatThread.findById(req.params.id)
    if (!thread || thread.type !== 'channel') return res.status(404).json({ error: 'Channel not found' })
    if (roleOf(thread, req.userId) !== 'owner' && !isChatModerator(req)) {
      return res.status(403).json({ error: 'Only the channel owner can archive' })
    }
    thread.archived = !!(req.body.archived ?? true)
    await thread.save()
    emitToParticipants(thread, null, 'thread_updated', { threadId: thread._id })
    res.json({ archived: thread.archived })
  } catch (err) {
    console.error('Archive channel error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function setMemberRole(req, res) {
  try {
    const { role } = req.body
    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'role must be admin or member' })

    const thread = await ChatThread.findById(req.params.id)
    if (!thread || thread.type !== 'channel') return res.status(404).json({ error: 'Channel not found' })
    if (roleOf(thread, req.userId) !== 'owner' && !isChatModerator(req)) {
      return res.status(403).json({ error: 'Only the channel owner can change roles' })
    }

    const targetId = req.params.userId
    if (roleOf(thread, targetId) === 'owner') return res.status(400).json({ error: 'Cannot change the owner role' })

    const entry = (thread.memberRoles || []).find(r => r.userId.toString() === targetId)
    if (entry) entry.role = role
    else thread.memberRoles.push({ userId: targetId, role })

    await thread.save()
    emitToParticipants(thread, null, 'thread_updated', { threadId: thread._id })
    res.json({ role })
  } catch (err) {
    console.error('Set member role error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Read receipts ───

export async function markThreadRead(req, res) {
  try {
    const { threadId } = req.params
    const thread = await ChatThread.findById(threadId).select('participants').lean()
    if (!thread || !isMember(thread, req.userId)) return res.status(403).json({ error: 'Access denied' })

    await Message.updateMany(
      { threadId, senderId: { $ne: req.userId }, 'readBy.userId': { $ne: req.userId } },
      { $push: { readBy: { userId: req.userId, readAt: new Date() } } }
    )
    emitToParticipants(thread, req.userId, 'thread_read', { threadId, userId: req.userId, readAt: new Date() })
    res.json({ message: 'Read' })
  } catch (err) {
    console.error('Mark thread read error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Per-user conversation preferences ───

export async function updateThreadPrefs(req, res) {
  try {
    const { threadId } = req.params
    const thread = await ChatThread.findById(threadId)
    if (!thread || !isMember(thread, req.userId)) return res.status(403).json({ error: 'Access denied' })

    let prefs = (thread.userPrefs || []).find(p => p.userId.toString() === req.userId.toString())
    if (!prefs) {
      thread.userPrefs.push({ userId: req.userId })
      prefs = thread.userPrefs[thread.userPrefs.length - 1]
    }

    const { pinned, favourite, mute, label, labelColor, background } = req.body
    if (pinned !== undefined) prefs.pinned = !!pinned
    if (favourite !== undefined) prefs.favourite = !!favourite
    if (mute !== undefined) {
      // mute: null/0 = unmute; number = minutes; 'forever'
      if (!mute) prefs.mutedUntil = null
      else if (mute === 'forever') prefs.mutedUntil = FOREVER
      else prefs.mutedUntil = new Date(Date.now() + Number(mute) * 60 * 1000)
    }
    if (label !== undefined) prefs.label = String(label).slice(0, 40)
    if (labelColor !== undefined) prefs.labelColor = String(labelColor).slice(0, 20)
    if (background !== undefined) prefs.background = String(background).slice(0, 40)

    await thread.save()
    const lean = await ChatThread.findById(threadId).populate('participants', 'displayName email avatar roles').lean()
    res.json(withMyPrefs(lean, req.userId))
  } catch (err) {
    console.error('Update thread prefs error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Mentions view ───

export async function getMyMentions(req, res) {
  try {
    const userThreads = await ChatThread.find({ participants: req.userId }).select('_id').lean()
    const threadIds = userThreads.map(t => t._id)

    const results = await Message.find({
      threadId: { $in: threadIds },
      deleted: { $ne: true },
      senderId: { $ne: req.userId },
      $or: [{ 'mentions.userId': req.userId }, { mentionsAll: true }],
    })
      .populate('senderId', 'displayName avatar')
      .populate('threadId', 'name type participants')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()

    res.json(results)
  } catch (err) {
    console.error('Get mentions error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Shared links per conversation ───

export async function getThreadLinks(req, res) {
  try {
    const { threadId } = req.params
    const thread = await ChatThread.findById(threadId).select('participants').lean()
    if (!thread || !isMember(thread, req.userId)) return res.status(403).json({ error: 'Access denied' })

    const messages = await Message.find({ threadId, deleted: { $ne: true }, 'linkUrls.0': { $exists: true } })
      .populate('senderId', 'displayName')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()

    const links = messages.flatMap(m => m.linkUrls.map(url => ({
      url,
      messageId: m._id,
      senderName: m.senderId?.displayName || 'Unknown',
      createdAt: m.createdAt,
    })))
    res.json(links)
  } catch (err) {
    console.error('Get thread links error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── #student tags autocomplete ───

export async function getTaggableStudents(req, res) {
  try {
    const { search } = req.query
    const filter = {}
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: regex }, { rollNo: regex }]
    }
    const students = await Student.find(filter)
      .select('name rollNo status')
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean()
    res.json(students)
  } catch (err) {
    console.error('Get taggable students error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Online user ids (presence bootstrap over REST) ───

export async function getOnlineUsers(req, res) {
  try {
    res.json(getOnlineUserIds())
  } catch {
    res.json([])
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
