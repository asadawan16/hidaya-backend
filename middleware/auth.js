import jwt from 'jsonwebtoken'

export default function auth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }

  try {
    const token = header.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.adminId = decoded.id
    req.adminRole = decoded.role || 'admin'
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}
