import { Router } from 'express'
import { portalAuth } from '../middleware/portalAuth.js'
import {
  listThreads, createChannel, updateChannel, getOrCreateDM,
  getMessages, getThreadReplies, sendMessage, editMessage, deleteMessage,
  toggleStar, togglePin, searchMessages, getMentionableUsers,
  toggleReaction, forwardMessage, leaveChannel, archiveChannel, setMemberRole,
  markThreadRead, updateThreadPrefs, getMyMentions, getThreadLinks,
  getTaggableStudents, getOnlineUsers,
} from '../controllers/portalChatController.js'

const router = Router()
router.use(portalAuth)

// Threads / Channels
router.get('/threads', listThreads)
router.post('/channels', createChannel)
router.patch('/channels/:id', updateChannel)
router.post('/channels/:id/leave', leaveChannel)
router.post('/channels/:id/archive', archiveChannel)
router.patch('/channels/:id/members/:userId/role', setMemberRole)
router.post('/dm', getOrCreateDM)

// Per-user thread preferences + read state
router.patch('/threads/:threadId/prefs', updateThreadPrefs)
router.post('/threads/:threadId/read', markThreadRead)
router.get('/threads/:threadId/links', getThreadLinks)

// Messages
router.get('/threads/:threadId/messages', getMessages)
router.post('/threads/:threadId/messages', sendMessage)
router.get('/messages/:messageId/replies', getThreadReplies)
router.patch('/messages/:messageId', editMessage)
router.delete('/messages/:messageId', deleteMessage)
router.post('/messages/:messageId/forward', forwardMessage)

// Star / Pin / React
router.post('/messages/:messageId/star', toggleStar)
router.post('/messages/:messageId/pin', togglePin)
router.post('/messages/:messageId/reactions', toggleReaction)

// Search + views
router.get('/search', searchMessages)
router.get('/mentions', getMyMentions)

// Autocomplete sources + presence bootstrap
router.get('/mentionable', getMentionableUsers)
router.get('/students-taggable', getTaggableStudents)
router.get('/online', getOnlineUsers)

export default router
