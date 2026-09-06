import { Router } from 'express'
import { listOffers, startCheckout, submitTrial } from '../controllers/publicCheckoutController.js'

/*
 * Unauthenticated endpoints for the satellite marketing sites
 * (currently qurantutornow.com). Rate-limited in index.js.
 */
const router = Router()

router.get('/offers/:channel', listOffers)
router.post('/checkout', startCheckout)
router.post('/trial', submitTrial)

export default router
