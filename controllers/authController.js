import jwt from 'jsonwebtoken'
import Admin from '../models/Admin.js'

export async function login(req, res) {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }

    const admin = await Admin.findOne({ email: email.toLowerCase() })
    if (!admin || !(await admin.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, admin: { id: admin._id, email: admin.email, name: admin.name } })
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
