import express from 'express'
import { verifyWhatsappWebhook, whatsappWebhook } from '../controllers/whatsappWebhookController.js'

// Mounted at /api/whatsapp/webhook BEFORE express.json() in index.js — the POST
// needs the raw bytes to check Meta's X-Hub-Signature-256.
const router = express.Router()

router.get('/', verifyWhatsappWebhook)
router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), whatsappWebhook)

export default router
