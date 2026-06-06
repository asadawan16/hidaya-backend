import Log from '../models/Log.js'

function categoryFromPath(path) {
  if (path.includes('/auth')) return 'auth'
  if (path.includes('/payment-links')) return 'payment_link'
  if (path.includes('/payments')) return 'payment'
  if (path.includes('/enrollments')) return 'enrollment'
  if (path.includes('/students')) return 'student'
  if (path.includes('/discount-codes')) return 'discount_code'
  if (path.includes('/blogs')) return 'blog'
  if (path.includes('/subscribers')) return 'subscriber'
  return 'system'
}

export default function requestLogger(req, res, next) {
  // Skip health check — not useful
  if (req.path === '/api/health') return next()

  const start = Date.now()

  res.on('finish', () => {
    const duration = Date.now() - start
    const { statusCode } = res
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warning' : 'info'
    const category = categoryFromPath(req.path)

    Log.create({
      level,
      category,
      action: `${req.method} ${req.path}`,
      message: `${req.method} ${req.path} → ${statusCode} (${duration}ms)`,
      method: req.method,
      path: req.path,
      statusCode,
      duration,
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      adminId: req.adminId || null,
    }).catch(() => {})
  })

  next()
}
