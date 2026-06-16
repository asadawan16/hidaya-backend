import { Router } from 'express'
import { portalAuth } from '../middleware/portalAuth.js'
import {
  listThreads, createChannel, updateChannel, getOrCreateDM,
  getMessages, getThreadReplies, sendMessage, editMessage, deleteMessage,
  toggleStar, togglePin, searchMessages, getMentionableUsers,
} from '../controllers/portalChatController.js'

const router = Router()
router.use(portalAuth)

// Threads / Channels
router.get('/threads', listThreads)
router.post('/channels', createChannel)
router.patch('/channels/:id', updateChannel)
router.post('/dm', getOrCreateDM)

// Messages
router.get('/threads/:threadId/messages', getMessages)
router.post('/threads/:threadId/messages', sendMessage)
router.get('/messages/:messageId/replies', getThreadReplies)
router.patch('/messages/:messageId', editMessage)
router.delete('/messages/:messageId', deleteMessage)

// Star / Pin
router.post('/messages/:messageId/star', toggleStar)
router.post('/messages/:messageId/pin', togglePin)

// Search
router.get('/search', searchMessages)

// Mentionable users
router.get('/mentionable', getMentionableUsers)

export default router
