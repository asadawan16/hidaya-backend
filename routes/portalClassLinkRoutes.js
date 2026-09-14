import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listClassLinks, createClassLink, updateClassLink, deleteClassLink,
  reorderClassLinks, getClassLinkSettings, updateClassLinkSettings,
} from '../controllers/portalClassLinkController.js'
import {
  listStudentClassLinks, upsertStudentClassLink, updateStudentClassLink,
  deleteStudentClassLink, bulkAssignStudentClassLinks, bulkDeleteStudentClassLinks,
} from '../controllers/portalStudentClassLinkController.js'

const router = Router()

router.use(portalAuth)

router.get('/settings', requirePermission('class_link.read'), getClassLinkSettings)
router.patch('/settings', requirePermission('class_link.manage'), updateClassLinkSettings)

// Per-student links (the "Student Links" tab) — declared before the bare
// '/:id' routes below so 'students' is never read as a link id.
router.get('/students', requirePermission('class_link.read'), listStudentClassLinks)
router.post('/students', requirePermission('class_link.manage'), upsertStudentClassLink)
router.post('/students/bulk', requirePermission('class_link.manage'), bulkAssignStudentClassLinks)
router.post('/students/bulk-delete', requirePermission('class_link.manage'), bulkDeleteStudentClassLinks)
router.patch('/students/:id', requirePermission('class_link.manage'), updateStudentClassLink)
router.delete('/students/:id', requirePermission('class_link.manage'), deleteStudentClassLink)

router.get('/', requirePermission('class_link.read'), listClassLinks)
router.post('/', requirePermission('class_link.manage'), createClassLink)
router.post('/reorder', requirePermission('class_link.manage'), reorderClassLinks)
router.patch('/:id', requirePermission('class_link.manage'), updateClassLink)
router.delete('/:id', requirePermission('class_link.manage'), deleteClassLink)

export default router
