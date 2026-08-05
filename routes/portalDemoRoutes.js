import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listDemos, getDemoStats, createDemo, updateDemo, updateDemoStatus, deleteDemo,
  pendingAnnouncement, ackAnnouncement, pickerDemoManagers,
} from '../controllers/portalDemoController.js'

const router = Router()
router.use(portalAuth)

// Students must never receive demo-trial announcements (they are staff popups).
// A student account is identified by its linkedStudentId. See mobile plan §9.
const blockStudents = (req, res, next) => {
  if (req.user?.linkedStudentId) return res.status(403).json({ error: 'Forbidden' })
  next()
}

// Announcement popup — available to ALL authenticated staff (no demo perm needed)
router.get('/pending-announcement', blockStudents, pendingAnnouncement)
router.post('/:id/ack', blockStudents, ackAnnouncement)

router.get('/', requirePermission('demo.read'), listDemos)
router.get('/stats', requirePermission('demo.read'), getDemoStats)
router.get('/managers', requirePermission('demo.manage'), pickerDemoManagers)
router.post('/', requirePermission('demo.manage'), createDemo)
router.patch('/:id', requirePermission('demo.manage'), updateDemo)
router.patch('/:id/status', requirePermission('demo.manage'), updateDemoStatus)
router.delete('/:id', requirePermission('demo.manage'), deleteDemo)

export default router
