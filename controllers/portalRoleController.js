import Role from '../models/Role.js'
import { ALL_PERMISSIONS, PERMISSIONS } from '../config/permissions.js'
import { logActivity } from '../utils/activityLogger.js'

export async function listRoles(req, res) {
  try {
    const roles = await Role.find().sort({ system: -1, key: 1 })
    res.json(roles)
  } catch (err) {
    console.error('List roles error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createRole(req, res) {
  try {
    const { key, name, permissions } = req.body

    if (!key || !name) {
      return res.status(400).json({ error: 'Key and name are required' })
    }

    const existing = await Role.findOne({ key: key.toLowerCase().trim() })
    if (existing) {
      return res.status(400).json({ error: 'A role with this key already exists' })
    }

    const invalid = (permissions || []).filter(p => !ALL_PERMISSIONS.includes(p))
    if (invalid.length > 0) {
      return res.status(400).json({ error: 'Invalid permissions', invalid })
    }

    const role = await Role.create({
      key: key.toLowerCase().trim(),
      name: name.trim(),
      permissions: permissions || [],
      system: false,
    })

    await logActivity({
      level: 'info',
      category: 'role_management',
      action: 'role_created',
      message: `Role created: ${role.key}`,
      req,
      meta: { roleId: role._id },
    })

    res.status(201).json(role)
  } catch (err) {
    console.error('Create role error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateRole(req, res) {
  try {
    const role = await Role.findById(req.params.id)
    if (!role) return res.status(404).json({ error: 'Role not found' })

    const { name, permissions } = req.body

    // System roles: can update permissions but not key
    if (name !== undefined) {
      if (role.system) {
        return res.status(400).json({ error: 'Cannot rename a system role' })
      }
      role.name = name.trim()
    }

    if (permissions !== undefined) {
      const invalid = permissions.filter(p => !ALL_PERMISSIONS.includes(p))
      if (invalid.length > 0) {
        return res.status(400).json({ error: 'Invalid permissions', invalid })
      }
      role.permissions = permissions
    }

    await role.save()

    await logActivity({
      level: 'info',
      category: 'role_management',
      action: 'role_updated',
      message: `Role updated: ${role.key}`,
      req,
      meta: { roleId: role._id },
    })

    res.json(role)
  } catch (err) {
    console.error('Update role error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteRole(req, res) {
  try {
    const role = await Role.findById(req.params.id)
    if (!role) return res.status(404).json({ error: 'Role not found' })

    if (role.system) {
      return res.status(400).json({ error: 'Cannot delete a system role' })
    }

    await Role.findByIdAndDelete(req.params.id)

    await logActivity({
      level: 'warning',
      category: 'role_management',
      action: 'role_deleted',
      message: `Role deleted: ${role.key}`,
      req,
      meta: { roleId: role._id },
    })

    res.json({ message: 'Role deleted' })
  } catch (err) {
    console.error('Delete role error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export function getPermissionCatalog(req, res) {
  // Return grouped permissions for the role editor UI
  const catalog = Object.entries(PERMISSIONS).map(([group, perms]) => ({
    group,
    permissions: perms,
  }))
  res.json({ catalog, all: ALL_PERMISSIONS })
}
