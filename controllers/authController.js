import jwt from 'jsonwebtoken'
import Admin from '../models/Admin.js'
import { logActivity } from '../utils/activityLogger.js'

export async function login(req, res) {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }

    const admin = await Admin.findOne({ email: email.toLowerCase() })
    if (!admin || !(await admin.comparePassword(password))) {
      logActivity({
        level: 'warning',
        category: 'auth',
        action: 'login_failed',
        message: `Failed login attempt for ${email}`,
        req,
        meta: { email },
      })
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const token = jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '7d' })

    logActivity({
      level: 'info',
      category: 'auth',
      action: 'login_success',
      message: `${admin.name} (${admin.email}) logged in`,
      req,
      meta: { adminId: admin._id, role: admin.role },
    })

    res.json({ token, admin: { id: admin._id, email: admin.email, name: admin.name, role: admin.role } })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getMe(req, res) {
  try {
    const admin = await Admin.findById(req.adminId).select('-password')
    if (!admin) return res.status(404).json({ error: 'Admin not found' })
    res.json(admin)
  } catch (err) {
    console.error('GetMe error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
