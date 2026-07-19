import { Router } from 'express'
import { portalAuth, requirePermission, requireAnyPermission } from '../middleware/portalAuth.js'
import {
  listTutors, getTutor, createTutor, updateTutor,
  deleteTutor, getTutorStats, getTutorDetailExtended,
  pickerTutors,
} from '../controllers/portalTutorController.js'

const router = Router()

router.use(portalAuth)

router.get('/', requirePermission('tutor.read'), listTutors)
router.get('/stats', requirePermission('tutor.read'), getTutorStats)
// Typeahead picker: full tutor.read OR the narrow tutor.pick (lesson logging) —
// lets teachers select a tutor without the Tutors directory or counts.
router.get('/picker', requireAnyPermission('tutor.read', 'tutor.pick'), pickerTutors)
router.get('/:id/detail', requirePermission('tutor.read'), getTutorDetailExtended)
router.get('/:id', requirePermission('tutor.read'), getTutor)
router.post('/', requirePermission('tutor.create'), createTutor)
router.patch('/:id', requirePermission('tutor.update'), updateTutor)
router.delete('/:id', requirePermission('tutor.delete'), deleteTutor)

export default router
