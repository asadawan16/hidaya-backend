import User from '../models/User.js'
import Role from '../models/Role.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'

export async function listUsers(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { search, status, role } = req.query

    const filter = {}

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ displayName: regex }, { email: regex }, { phone: regex }]
    }

    if (status) filter.status = status

    if (role) {
      const roleDoc = await Role.findOne({ key: role })
      if (roleDoc) filter.roles = roleDoc._id
    }

    const total = await User.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await User.find(filter)
      .populate('roles', 'key name')
      .select('-password -mfa.secretEnc')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List users error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Lightweight typeahead picker for dropdowns (chat DM, notice audience, etc.)
export async function pickerUsers(req, res) {
  try {
    const lim = Math.max(1, Math.min(30, parseInt(req.query.limit, 10) || 20))
    const { q, status, ids } = req.query

    const filter = {}
    if (status) filter.status = status

    if (ids) {
      const idList = String(ids).split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)
      filter._id = { $in: idList }
    } else if (q) {
      const regex = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ displayName: regex }, { email: regex }]
    }

    const records = await User.find(filter)
      .populate('roles', 'key name')
      .select('displayName email status roles')
      .sort({ displayName: 1 })
      .limit(ids ? 50 : lim)
      .lean()

    res.json(records)
  } catch (err) {
    console.error('User picker error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getUser(req, res) {
  try {
    const user = await User.findById(req.params.id)
      .populate('roles', 'key name permissions')
      .select('-password -mfa.secretEnc')
      .lean()

    if (!user) return res.status(404).json({ error: 'User not found' })

    res.json(user)
  } catch (err) {
    console.error('Get user error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createUser(req, res) {
  try {
    const { email, password, displayName, phone, roleKeys, status } = req.body

    if (!email || !password || !displayName) {
      return res.status(400).json({ error: 'Email, password, and display name are required' })
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() })
    if (existing) {
      return res.status(400).json({ error: 'A user with this email already exists' })
    }

    // Resolve role keys to ObjectIds
    const keys = roleKeys || ['student']
    const roles = await Role.find({ key: { $in: keys } })
    if (roles.length === 0) {
      return res.status(400).json({ error: 'At least one valid role is required' })
    }

    const user = await User.create({
      email: email.toLowerCase().trim(),
      password,
      displayName: displayName.trim(),
      phone: phone?.trim() || '',
      roles: roles.map(r => r._id),
      status: status || 'active',
    })

    await logActivity({
      level: 'info',
      category: 'user_management',
      action: 'user_created',
      message: `User created: ${user.email} with roles [${keys.join(', ')}]`,
      req,
      meta: { targetUserId: user._id },
    })

    await createNotification({
      userId: user._id,
      type: 'user_account',
      title: 'Welcome to Hidaya Online',
      body: `Assalamu Alaikum ${user.displayName}! Your portal account has been created.`,
      payload: { roles: keys },
    })

    const populated = await User.findById(user._id)
      .populate('roles', 'key name')
      .select('-password -mfa.secretEnc')

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create user error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateUser(req, res) {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { displayName, phone, roleKeys, status } = req.body

    if (displayName !== undefined) user.displayName = displayName.trim()
    if (phone !== undefined) user.phone = phone.trim()
    if (status !== undefined) user.status = status

    if (roleKeys !== undefined) {
      const roles = await Role.find({ key: { $in: roleKeys } })
      if (roles.length === 0) {
        return res.status(400).json({ error: 'At least one valid role is required' })
      }
      user.roles = roles.map(r => r._id)
    }

    await user.save()

    await logActivity({
      level: 'info',
      category: 'user_management',
      action: 'user_updated',
      message: `User updated: ${user.email}`,
      req,
      meta: { targetUserId: user._id },
    })

    const populated = await User.findById(user._id)
      .populate('roles', 'key name')
      .select('-password -mfa.secretEnc')

    res.json(populated)
  } catch (err) {
    console.error('Update user error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteUser(req, res) {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Prevent deleting yourself
    if (user._id.toString() === req.userId.toString()) {
      return res.status(400).json({ error: 'Cannot delete your own account' })
    }

    await User.findByIdAndDelete(req.params.id)

    await logActivity({
      level: 'warning',
      category: 'user_management',
      action: 'user_deleted',
      message: `User deleted: ${user.email}`,
      req,
      meta: { targetUserId: user._id },
    })

    res.json({ message: 'User deleted' })
  } catch (err) {
    console.error('Delete user error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function resetPassword(req, res) {
  try {
    const { newPassword } = req.body
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }

    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    user.password = newPassword
    await user.save() // pre-save hook hashes it

    await logActivity({
      level: 'info',
      category: 'user_management',
      action: 'password_reset',
      message: `Password reset for ${user.email} by ${req.user.email}`,
      req,
      meta: { targetUserId: user._id },
    })

    await createNotification({
      userId: user._id,
      type: 'user_account',
      title: 'Password Reset',
      body: 'Your account password was reset by an administrator. If this was not expected, contact support.',
      payload: {},
    })

    res.json({ message: 'Password reset successfully' })
  } catch (err) {
    console.error('Reset password error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getProfile(req, res) {
  try {
    const user = await User.findById(req.userId)
      .populate('roles', 'key name permissions')
      .select('-password -mfa.secretEnc')
      .lean()
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(user)
  } catch (err) {
    console.error('Get profile error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateProfile(req, res) {
  try {
    const user = await User.findById(req.userId)
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { displayName, phone, avatar, bio } = req.body
    if (displayName !== undefined) user.displayName = displayName.trim()
    if (phone !== undefined) user.phone = phone.trim()
    if (avatar !== undefined) user.avatar = avatar.trim()
    if (bio !== undefined) user.bio = bio.trim()

    await user.save()

    const populated = await User.findById(user._id)
      .populate('roles', 'key name')
      .select('-password -mfa.secretEnc')
      .lean()

    res.json(populated)
  } catch (err) {
    console.error('Update profile error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' })
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' })
    }

    const user = await User.findById(req.userId)
    if (!user) return res.status(404).json({ error: 'User not found' })

    const valid = await user.comparePassword(currentPassword)
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' })

    user.password = newPassword
    await user.save()

    res.json({ message: 'Password changed successfully' })
  } catch (err) {
    console.error('Change password error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
