import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import { generateSecret, encryptSecret, verifyToken, generateQRDataUrl } from '../utils/totp.js'
import { isWithinShiftWindow } from '../utils/shiftWindow.js'
import { logActivity } from '../utils/activityLogger.js'
import TutorProfile from '../models/TutorProfile.js'

export async function portalLogin(req, res) {
  try {
    const { email, password, totpCode } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() })
      .populate('roles')

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    if (user.status !== 'active') {
      return res.status(401).json({ error: 'Account is suspended or pending approval' })
    }

    const valid = await user.comparePassword(password)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    // Shift-window gate for tutors
    if (user.mustLoginWithinShift && user.linkedTutorId) {
      try {
        const tutor = await TutorProfile.findById(user.linkedTutorId).lean()
        if (tutor && tutor.shiftWindows?.length > 0) {
          const timezone = tutor.shiftWindows[0]?.timezone || 'Asia/Karachi'
          if (!isWithinShiftWindow(tutor.shiftWindows, timezone)) {
            await logActivity({
              level: 'warning',
              category: 'portal',
              action: 'login_shift_blocked',
              message: `Login blocked outside shift: ${user.email}`,
              req,
              meta: { userId: user._id },
            })
            return res.status(403).json({
              error: 'Login is not allowed outside your shift window',
              code: 'SHIFT_BLOCKED',
            })
          }
        }
      } catch {
        // TutorProfile query failed — skip shift check
      }
    }

    // MFA check
    if (user.mfa?.enabled) {
      if (!totpCode) {
        return res.json({ mfaRequired: true })
      }

      const validTotp = verifyToken(user.mfa.secretEnc, totpCode)
      if (!validTotp) {
        await logActivity({
          level: 'warning',
          category: 'mfa',
          action: 'totp_failed',
          message: `Invalid TOTP code for ${user.email}`,
          req,
          meta: { userId: user._id },
        })
        return res.status(401).json({ error: 'Invalid TOTP code' })
      }
    }

    // Sign JWT
    const token = jwt.sign(
      { id: user._id, type: 'portal' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    )

    user.lastLoginAt = new Date()
    await user.save()

    await logActivity({
      level: 'info',
      category: 'portal',
      action: 'portal_login',
      message: `Portal login: ${user.email}`,
      req,
      meta: { userId: user._id },
    })

    const roleData = user.roles.map(r => ({
      _id: r._id,
      key: r.key,
      name: r.name,
      permissions: r.permissions,
    }))

    res.json({
      token,
      user: {
        _id: user._id,
        email: user.email,
        displayName: user.displayName,
        phone: user.phone,
        status: user.status,
        roles: roleData,
        mfaEnabled: user.mfa?.enabled || false,
        lastLoginAt: user.lastLoginAt,
        linkedStudentId: user.linkedStudentId || null,
        linkedTutorId: user.linkedTutorId || null,
      },
    })
  } catch (err) {
    console.error('Portal login error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function portalGetMe(req, res) {
  try {
    const roleData = req.user.roles.map(r => ({
      _id: r._id,
      key: r.key,
      name: r.name,
      permissions: r.permissions,
    }))

    res.json({
      _id: req.user._id,
      email: req.user.email,
      displayName: req.user.displayName,
      phone: req.user.phone,
      status: req.user.status,
      roles: roleData,
      mfaEnabled: req.user.mfa?.enabled || false,
      lastLoginAt: req.user.lastLoginAt,
      linkedStudentId: req.user.linkedStudentId || null,
      linkedTutorId: req.user.linkedTutorId || null,
    })
  } catch (err) {
    console.error('Portal getMe error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function enrollMfa(req, res) {
  try {
    const { userId } = req.body
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const user = await User.findById(userId)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    if (user.mfa?.enabled) {
      return res.status(400).json({ error: 'MFA is already enabled for this user' })
    }

    const { secret, otpauthUrl } = generateSecret(user.email)
    const secretEnc = encryptSecret(secret)
    const qrDataUrl = await generateQRDataUrl(otpauthUrl)

    // Store secret but keep MFA disabled until user confirms with a valid code
    user.mfa = {
      enabled: false,
      secretEnc,
      enrolledBy: req.userId,
      enrolledAt: new Date(),
    }
    await user.save()

    res.json({
      qrDataUrl,
      manualKey: secret,
      message: 'Scan the QR code, then enter the 6-digit code to confirm.',
    })
  } catch (err) {
    console.error('Enroll MFA error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function confirmMfa(req, res) {
  try {
    const { userId, token } = req.body
    if (!userId || !token) {
      return res.status(400).json({ error: 'userId and token are required' })
    }

    const user = await User.findById(userId)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    if (user.mfa?.enabled) {
      return res.status(400).json({ error: 'MFA is already enabled' })
    }

    if (!user.mfa?.secretEnc) {
      return res.status(400).json({ error: 'No pending MFA enrollment found. Generate a QR code first.' })
    }

    const valid = verifyToken(user.mfa.secretEnc, token)
    if (!valid) {
      return res.status(400).json({ error: 'Invalid code. Please check your authenticator app and try again.' })
    }

    user.mfa.enabled = true
    await user.save()

    await logActivity({
      level: 'info',
      category: 'mfa',
      action: 'mfa_enrolled',
      message: `MFA enrolled for ${user.email} by ${req.user.email}`,
      req,
      meta: { targetUserId: userId },
    })

    res.json({ message: 'MFA enabled successfully.' })
  } catch (err) {
    console.error('Confirm MFA error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function revokeMfa(req, res) {
  try {
    const { userId } = req.body
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    const user = await User.findById(userId)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    if (!user.mfa?.enabled && !user.mfa?.secretEnc) {
      return res.status(400).json({ error: 'MFA is not enabled for this user' })
    }

    user.mfa = { enabled: false, secretEnc: '', enrolledBy: null, enrolledAt: null }
    await user.save()

    await logActivity({
      level: 'info',
      category: 'mfa',
      action: 'mfa_revoked',
      message: `MFA revoked for ${user.email} by ${req.user.email}`,
      req,
      meta: { targetUserId: userId },
    })

    res.json({ message: 'MFA revoked successfully' })
  } catch (err) {
    console.error('Revoke MFA error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
