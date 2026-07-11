import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  createTutorChangeRequest, listTutorChangeRequests,
  approveTutorChangeRequest, rejectTutorChangeRequest,
} from '../controllers/portalTutorChangeController.js'

const router = Router()
router.use(portalAuth)

// Reviewers (assignment.read) OR requesters (assignment.request, incl. students) can list.
// The controller scopes students to their own requests.
const canList = (req, res, next) => {
  if (req.userPermissions.has('assignment.read') || req.userPermissions.has('assignment.request')) return next()
  return res.status(403).json({ error: 'Insufficient permissions' })
}
router.get('/', canList, listTutorChangeRequests)
router.post('/', requirePermission('assignment.request'), createTutorChangeRequest)
router.post('/:id/approve', requirePermission('assignment.approve'), approveTutorChangeRequest)
router.post('/:id/reject', requirePermission('assignment.approve'), rejectTutorChangeRequest)

export default router
