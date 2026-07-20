import { Router } from 'express'
import { portalAuth, requirePermission, requireAnyPermission } from '../middleware/portalAuth.js'
import {
  listNotices, createNotice, updateNotice, deleteNotice,
  getActiveNoticesForUser, acknowledgeNotice, getNoticeAckStatus,
  listComplaints, createComplaint, resolveComplaint, updateComplaint, deleteComplaint,
  sendWhatsappReminder,
} from '../controllers/portalNoticeController.js'

const router = Router()
router.use(portalAuth)

// Active notices for current user (no special permission — all authenticated users)
router.get('/active', getActiveNoticesForUser)

// Notices
router.get('/notices', requirePermission('notice.read'), listNotices)
router.post('/notices', requirePermission('notice.create'), createNotice)
router.patch('/notices/:id', requirePermission('notice.manage'), updateNotice)
router.delete('/notices/:id', requirePermission('notice.manage'), deleteNotice)
router.post('/notices/:id/acknowledge', acknowledgeNotice)
router.get('/notices/:id/ack-status', requirePermission('notice.manage'), getNoticeAckStatus)

// Complaints
router.get('/complaints', requirePermission('complaint.read'), listComplaints)
router.post('/complaints', requirePermission('complaint.create'), createComplaint)
// Resolving a complaint is a complaint action — allow it for complaint managers
// (complaint.update) as well as the legacy notice.manage, so complaint.* is
// self-sufficient and independent of the notice domain.
router.post('/complaints/:id/resolve', requireAnyPermission('complaint.update', 'notice.manage'), resolveComplaint)
router.patch('/complaints/:id', requirePermission('complaint.update'), updateComplaint)
router.delete('/complaints/:id', requirePermission('complaint.delete'), deleteComplaint)

// WhatsApp
router.post('/whatsapp-reminder', requirePermission('whatsapp.send'), sendWhatsappReminder)

export default router
