import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  listAssessments, createAssessment, getAssessment, getReportCard,
} from '../controllers/portalAssessmentController.js'

const router = Router()
router.use(portalAuth)

// Templates
router.get('/templates', requirePermission('assessment.read'), listTemplates)
router.post('/templates', requirePermission('assessment.template_manage'), createTemplate)
router.patch('/templates/:id', requirePermission('assessment.template_manage'), updateTemplate)
router.delete('/templates/:id', requirePermission('assessment.template_manage'), deleteTemplate)

// Assessments
router.get('/', requirePermission('assessment.read'), listAssessments)
router.get('/:id/report-card', requirePermission('assessment.read'), getReportCard)
router.get('/:id', requirePermission('assessment.read'), getAssessment)
router.post('/', requirePermission('assessment.create'), createAssessment)

export default router
