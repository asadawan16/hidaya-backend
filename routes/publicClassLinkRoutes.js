import { Router } from 'express'
import {
  getPublicClassLinks, trackClassLinkClick,
  getPublicStudentClassLink, trackStudentClassLinkClick,
} from '../controllers/publicClassLinkController.js'

// PUBLIC — no auth. Backs the shareable /class-links board and the per-student
// /my-class/:token pages (rate limited in index.js).
const router = Router()

router.get('/public', getPublicClassLinks)
router.get('/student/:token', getPublicStudentClassLink)
router.post('/student/:token/click', trackStudentClassLinkClick)
router.post('/:id/click', trackClassLinkClick)

export default router
