import express, { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { denyStudentAccounts } from '../middleware/studentScope.js'
import {
  listChats, getChatMessages, readChat, sendChatMessage, sendChatMedia, getChatMedia, listChatTemplates, MEDIA_UPLOAD_LIMIT,
} from '../controllers/portalWhatsappChatController.js'

// /api/portal/whatsapp-chats — staff view on whatsapp.chat, full view with
// whatsapp.inbox as well (see the controller for what each one may see)
const router = Router()
router.use(portalAuth, denyStudentAccounts, requirePermission('whatsapp.chat'))
const inboxOnly = requirePermission('whatsapp.inbox')

router.get('/', listChats)
router.get('/templates', inboxOnly, listChatTemplates)
router.get('/media/:messageId', getChatMedia)
router.get('/:id/messages', getChatMessages)
router.post('/:id/read', readChat)
router.post('/:id/messages', sendChatMessage)
// The file is the request body; express.json() upstream leaves non-JSON types alone
router.post('/:id/media', inboxOnly, express.raw({ type: () => true, limit: MEDIA_UPLOAD_LIMIT }), sendChatMedia)

export default router
