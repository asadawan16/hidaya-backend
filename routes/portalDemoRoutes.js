import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listDemos, getDemoStats, createDemo, updateDemo, updateDemoStatus, deleteDemo,
} from '../controllers/portalDemoController.js'

const router = Router()
router.use(portalAuth)

router.get('/', requirePermission('demo.read'), listDemos)
router.get('/stats', requirePermission('demo.read'), getDemoStats)
router.post('/', requirePermission('demo.manage'), createDemo)
router.patch('/:id', requirePermission('demo.manage'), updateDemo)
router.patch('/:id/status', requirePermission('demo.manage'), updateDemoStatus)
router.delete('/:id', requirePermission('demo.manage'), deleteDemo)

export default router
