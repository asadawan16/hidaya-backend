import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import User from '../models/User.js'
import { generateSecret, encryptSecret, verifyToken, generateQRDataUrl } from '../utils/totp.js'
import { isWithinShiftWindow } from '../utils/shiftWindow.js'
import { logActivity } from '../utils/activityLogger.js'
import { sendToUser, passwordResetOtpEmail } from '../services/mailer.js'
import TutorProfile from '../models/TutorProfile.js'

const OTP_TTL_MS = 10 * 60 * 1000 // 10 minutes
const OTP_MAX_ATTEMPTS = 5

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

/**
 * Step 1 of password reset. If the account has MFA enabled, a valid TOTP code
 * must be supplied here BEFORE any OTP email is sent (prevents an attacker who
 * only knows the email from triggering reset codes). Responds generically to
 * limit account enumeration — the only signal ever leaked is `mfaRequired`.
 */
export async function forgotPassword(req, res) {
  try {
    const { email, totpCode } = req.body
    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() })
    const genericResponse = { otpSent: true }

    // Unknown or non-active account — pretend success, send nothing
    if (!user || user.status !== 'active') {
      return res.json(genericResponse)
    }

    // MFA gate: require a valid TOTP before issuing the email OTP
    if (user.mfa?.enabled) {
      if (!totpCode) {
        return res.json({ mfaRequired: true })
      }
      const validTotp = verifyToken(user.mfa.secretEnc, totpCode)
      if (!validTotp) {
        await logActivity({
          level: 'warning',
          category: 'mfa',
          action: 'reset_totp_failed',
          message: `Invalid TOTP during password reset for ${user.email}`,
          req,
          meta: { userId: user._id },
        })
        return res.status(401).json({ error: 'Invalid TOTP code' })
      }
    }

    // Generate + store a hashed 6-digit OTP
    const otp = String(crypto.randomInt(100000, 1000000))
    const otpHash = await bcrypt.hash(otp, 10)
    user.passwordReset = { otpHash, expiresAt: new Date(Date.now() + OTP_TTL_MS), attempts: 0 }
    await user.save()

    const { subject, html } = passwordResetOtpEmail({ displayName: user.displayName, otp })
    await sendToUser({ to: user.email, subject, html })

    await logActivity({
      level: 'info',
      category: 'portal',
      action: 'password_reset_requested',
      message: `Password reset OTP sent to ${user.email}`,
      req,
      meta: { userId: user._id },
    })

    res.json(genericResponse)
  } catch (err) {
    console.error('Forgot password error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/** Step 2 of password reset — verify the emailed OTP and set the new password. */
export async function resetPassword(req, res) {
  try {
    const { email, otp, newPassword } = req.body
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' })
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() })
    if (!user || !user.passwordReset?.otpHash) {
      return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' })
    }

    if (!user.passwordReset.expiresAt || user.passwordReset.expiresAt < new Date()) {
      user.passwordReset = { otpHash: '', expiresAt: null, attempts: 0 }
      await user.save()
      return res.status(400).json({ error: 'This code has expired. Please request a new one.' })
    }

    if (user.passwordReset.attempts >= OTP_MAX_ATTEMPTS) {
      user.passwordReset = { otpHash: '', expiresAt: null, attempts: 0 }
      await user.save()
      return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' })
    }

    const match = await bcrypt.compare(String(otp), user.passwordReset.otpHash)
    if (!match) {
      user.passwordReset.attempts += 1
      await user.save()
      return res.status(400).json({ error: 'Incorrect code. Please try again.' })
    }

    // Success — set new password (pre-save hook hashes it) and clear reset state
    user.password = newPassword
    user.passwordReset = { otpHash: '', expiresAt: null, attempts: 0 }
    await user.save()

    await logActivity({
      level: 'info',
      category: 'portal',
      action: 'password_reset_completed',
      message: `Password reset completed for ${user.email}`,
      req,
      meta: { userId: user._id },
    })

    res.json({ message: 'Password reset successfully. You can now sign in with your new password.' })
  } catch (err) {
    console.error('Reset password error:', err)
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
