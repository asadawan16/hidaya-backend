import { Router } from 'express'
import { getPublicClassLinks, trackClassLinkClick } from '../controllers/publicClassLinkController.js'

// PUBLIC — no auth. Backs the shareable /class-links page (rate limited in index.js).
const router = Router()

router.get('/public', getPublicClassLinks)
router.post('/:id/click', trackClassLinkClick)

export default router
