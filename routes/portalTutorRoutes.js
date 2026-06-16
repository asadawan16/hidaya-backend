import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listTutors, getTutor, createTutor, updateTutor,
  deleteTutor, getTutorStats,
} from '../controllers/portalTutorController.js'

const router = Router()

router.use(portalAuth)

router.get('/', requirePermission('tutor.read'), listTutors)
router.get('/stats', requirePermission('tutor.read'), getTutorStats)
router.get('/:id', requirePermission('tutor.read'), getTutor)
router.post('/', requirePermission('tutor.create'), createTutor)
router.patch('/:id', requirePermission('tutor.update'), updateTutor)
router.delete('/:id', requirePermission('tutor.delete'), deleteTutor)

export default router
