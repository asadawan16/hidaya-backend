import { Router } from 'express'
import { listUsers, getUser, createUser, updateUser, deleteUser, resetPassword, getProfile, updateProfile, changePassword } from '../controllers/portalUserController.js'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'

const router = Router()

router.use(portalAuth)

// Profile — own user
router.get('/profile', getProfile)
router.patch('/profile', updateProfile)
router.post('/profile/change-password', changePassword)

router.get('/', requirePermission('user.read'), listUsers)
router.post('/', requirePermission('user.create'), createUser)
router.get('/:id', requirePermission('user.read'), getUser)
router.patch('/:id', requirePermission('user.update'), updateUser)
router.delete('/:id', requirePermission('user.delete'), deleteUser)
router.post('/:id/reset-password', requirePermission('user.update'), resetPassword)

export default router
