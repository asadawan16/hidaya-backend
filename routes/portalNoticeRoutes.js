import { Router } from 'express'
import { denyStudentAccounts } from '../middleware/studentScope.js'
import { portalAuth, requirePermission, requireAnyPermission } from '../middleware/portalAuth.js'
import {
  listNotices, createNotice, updateNotice, deleteNotice,
  getActiveNoticesForUser, acknowledgeNotice, getNoticeAckStatus,
  listComplaints, createComplaint, resolveComplaint, updateComplaint, deleteComplaint,
} from '../controllers/portalNoticeController.js'

const router = Router()
router.use(portalAuth)

// Active notices for current user (no special permission — all authenticated users)
router.get('/active', getActiveNoticesForUser)

// Notices
// The full notice list is staff-facing (teacher notices name other students).
// Students read their own scoped feed from /active.
router.get('/notices', requirePermission('notice.read'), denyStudentAccounts, listNotices)
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

// The old wa.me reminder link (whatsapp.send) is retired: it showed tutors the
// family's number. Reminders are now sent from the academy's number — see
// /portal/class-reminders.
router.post('/whatsapp-reminder', (_req, res) => res.status(410).json({
  error: 'This reminder link has been retired. Send reminders from your class on the Schedule page.',
}))

export default router
