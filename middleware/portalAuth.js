import jwt from 'jsonwebtoken'
import User from '../models/User.js'

/**
 * Base portal authentication middleware.
 * Verifies JWT, loads user with populated roles, builds permission set.
 * Sets: req.user, req.userId, req.userPermissions (Set)
 */
export async function portalAuth(req, res, next) {
  try {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const token = header.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type !== 'portal') {
      return res.status(401).json({ error: 'Invalid token type' })
    }

    const user = await User.findById(decoded.id)
      .populate('roles')
      .select('-password')

    if (!user) {
      return res.status(401).json({ error: 'User not found' })
    }

    if (user.status !== 'active') {
      return res.status(401).json({ error: 'Account is suspended or pending' })
    }

    // Build flat permission set from all roles
    const permissions = new Set()
    for (const role of user.roles) {
      for (const perm of role.permissions) {
        permissions.add(perm)
      }
    }

    req.user = user
    req.userId = user._id
    req.userPermissions = permissions
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' })
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' })
    }
    console.error('Portal auth error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/**
 * Permission-checking middleware factory.
 * Usage: requirePermission('student.read', 'student.update')
 * All specified permissions must be present.
 */
export function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.userPermissions) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const missing = permissions.filter(p => !req.userPermissions.has(p))
    if (missing.length > 0) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        missing,
      })
    }

    next()
  }
}

/**
 * Role-checking middleware factory (by role key).
 * Usage: requireRole('super_admin')
 * Passes if the user holds ANY ONE of the given role keys.
 */
export function requireRole(...roleKeys) {
  return (req, res, next) => {
    const keys = (req.user?.roles || []).map(r => r.key)
    if (roleKeys.some(k => keys.includes(k))) return next()
    return res.status(403).json({ error: 'Insufficient permissions' })
  }
}

/**
 * Passes if the user holds ANY ONE of the given permissions (OR semantics).
 * Usage: requireAnyPermission('student.read', 'student.pick')
 */
export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.userPermissions) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    if (permissions.some(p => req.userPermissions.has(p))) {
      return next()
    }
    return res.status(403).json({ error: 'Insufficient permissions', missing: permissions })
  }
}
