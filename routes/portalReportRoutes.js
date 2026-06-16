import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import { getStudentReport, getBulkReportData, getTutorPerformance } from '../controllers/portalReportController.js'

const router = Router()
router.use(portalAuth)

router.get('/student/:studentId', requirePermission('report.read'), getStudentReport)
router.post('/bulk', requirePermission('report.generate'), getBulkReportData)
router.get('/tutor-performance', requirePermission('report.read'), getTutorPerformance)

export default router
