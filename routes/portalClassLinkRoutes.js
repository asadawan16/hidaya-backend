import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listClassLinks, createClassLink, updateClassLink, deleteClassLink,
  reorderClassLinks, getClassLinkSettings, updateClassLinkSettings,
} from '../controllers/portalClassLinkController.js'

const router = Router()

router.use(portalAuth)

router.get('/settings', requirePermission('class_link.read'), getClassLinkSettings)
router.patch('/settings', requirePermission('class_link.manage'), updateClassLinkSettings)
router.get('/', requirePermission('class_link.read'), listClassLinks)
router.post('/', requirePermission('class_link.manage'), createClassLink)
router.post('/reorder', requirePermission('class_link.manage'), reorderClassLinks)
router.patch('/:id', requirePermission('class_link.manage'), updateClassLink)
router.delete('/:id', requirePermission('class_link.manage'), deleteClassLink)

export default router
