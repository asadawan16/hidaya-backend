import express, { Router } from 'express'
import { portalAuth } from '../middleware/portalAuth.js'
import { denyStudentAccounts } from '../middleware/studentScope.js'
import {
  listChats, getChatMessages, readChat, sendChatMessage, sendChatMedia, getChatMedia, listChatTemplates, MEDIA_UPLOAD_LIMIT,
  archiveChat, removeChat, renameChat, importContactList, getContactSummary,
} from '../controllers/portalWhatsappChatController.js'
import { chatLevel } from '../utils/whatsappAccess.js'

// /api/portal/whatsapp-chats — any chat level gets in (own students / all
// chats = staff view); templates and file uploads need the full inbox. See
// utils/whatsappAccess.js for the levels and the controller for what each sees.
const atLeast = (...levels) => (req, res, next) => (
  levels.includes(chatLevel(req.userPermissions)) ? next() : res.status(403).json({ error: 'Insufficient permissions' })
)
const router = Router()
router.use(portalAuth, denyStudentAccounts, atLeast('own', 'all', 'full'))
const inboxOnly = atLeast('full')

router.get('/', listChats)
router.get('/contacts/summary', inboxOnly, getContactSummary)
router.post('/contacts/import', inboxOnly, importContactList)
router.get('/templates', inboxOnly, listChatTemplates)
router.get('/media/:messageId', getChatMedia)
router.get('/:id/messages', getChatMessages)
router.post('/:id/read', readChat)
router.post('/:id/messages', sendChatMessage)
router.post('/:id/archive', inboxOnly, archiveChat)
router.delete('/:id', inboxOnly, removeChat)
router.put('/:id/name', inboxOnly, renameChat)
// The file is the request body; express.json() upstream leaves non-JSON types alone
router.post('/:id/media', inboxOnly, express.raw({ type: () => true, limit: MEDIA_UPLOAD_LIMIT }), sendChatMedia)

export default router
