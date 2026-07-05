import { Router } from 'express'
import { listRoles, createRole, updateRole, deleteRole, getPermissionCatalog } from '../controllers/portalRoleController.js'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'

const router = Router()

router.use(portalAuth)

router.get('/', requirePermission('role.read'), listRoles)
router.post('/', requirePermission('role.create'), createRole)
router.get('/permissions', requirePermission('role.read'), getPermissionCatalog)
router.patch('/:id', requirePermission('role.update'), updateRole)
router.delete('/:id', requirePermission('role.delete'), deleteRole)

export default router
