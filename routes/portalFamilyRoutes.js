import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listFamilies, getFamily, createFamily, updateFamily, deleteFamily,
  getFamilyStats, searchFamilies, checkFamilyCode,
} from '../controllers/portalFamilyController.js'

const router = Router()
router.use(portalAuth)

router.get('/stats', requirePermission('family.read'), getFamilyStats)
router.get('/check-code', requirePermission('family.read'), checkFamilyCode)
router.get('/search', requirePermission('family.read'), searchFamilies)
router.get('/', requirePermission('family.read'), listFamilies)
router.get('/:id', requirePermission('family.read'), getFamily)
router.post('/', requirePermission('family.create'), createFamily)
router.patch('/:id', requirePermission('family.update'), updateFamily)
router.delete('/:id', requirePermission('family.delete'), deleteFamily)

export default router
