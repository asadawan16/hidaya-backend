import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listNotices, createNotice, updateNotice,
  listComplaints, createComplaint, resolveComplaint,
  sendWhatsappReminder,
} from '../controllers/portalNoticeController.js'

const router = Router()
router.use(portalAuth)

// Notices
router.get('/notices', requirePermission('notice.read'), listNotices)
router.post('/notices', requirePermission('notice.create'), createNotice)
router.patch('/notices/:id', requirePermission('notice.manage'), updateNotice)

// Complaints
router.get('/complaints', requirePermission('complaint.read'), listComplaints)
router.post('/complaints', requirePermission('complaint.create'), createComplaint)
router.post('/complaints/:id/resolve', requirePermission('notice.manage'), resolveComplaint)

// WhatsApp
router.post('/whatsapp-reminder', requirePermission('whatsapp.send'), sendWhatsappReminder)

export default router
