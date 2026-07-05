import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listCurriculum, getCurriculumItem, createCurriculumItem,
  updateCurriculumItem, deleteCurriculumItem,
  getCurriculumStats, seedCurriculum,
} from '../controllers/portalCurriculumController.js'

const router = Router()

router.use(portalAuth)

router.get('/', requirePermission('lesson.read'), listCurriculum)
router.get('/stats', requirePermission('lesson.read'), getCurriculumStats)
router.post('/seed', requirePermission('assessment.template_manage'), seedCurriculum)
router.get('/:id', requirePermission('lesson.read'), getCurriculumItem)
router.post('/', requirePermission('assessment.template_manage'), createCurriculumItem)
router.patch('/:id', requirePermission('assessment.template_manage'), updateCurriculumItem)
router.delete('/:id', requirePermission('assessment.template_manage'), deleteCurriculumItem)

export default router
