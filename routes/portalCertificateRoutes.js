import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listCertificates, createCertificate, bulkCreateCertificates,
  getCertificate, deleteCertificate, approveCertificate, rejectCertificate,
  getUnacknowledgedCerts, acknowledgeCertificate,
} from '../controllers/portalCertificateController.js'

const router = Router()
router.use(portalAuth)

router.get('/unacknowledged', getUnacknowledgedCerts)
router.get('/', requirePermission('certificate.read'), listCertificates)
router.post('/', requirePermission('certificate.submit'), createCertificate)
router.post('/bulk', requirePermission('certificate.submit'), bulkCreateCertificates)
router.post('/:id/approve', requirePermission('certificate.approve'), approveCertificate)
router.post('/:id/reject', requirePermission('certificate.approve'), rejectCertificate)
router.post('/:id/acknowledge', acknowledgeCertificate)
router.get('/:id', requirePermission('certificate.read'), getCertificate)
router.delete('/:id', requirePermission('certificate.approve'), deleteCertificate)

export default router
