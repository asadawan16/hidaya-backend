import Log from '../models/Log.js'

export async function list(req, res) {
  try {
    const { level, category, method, startDate, endDate, search } = req.query
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50))

    const filter = {}
    if (level) filter.level = level
    if (category) filter.category = category
    if (method) filter.method = method.toUpperCase()
    if (startDate || endDate) {
      filter.createdAt = {}
      if (startDate) filter.createdAt.$gte = new Date(startDate)
      if (endDate) filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999))
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ message: regex }, { action: regex }, { path: regex }, { ip: regex }]
    }

    const total = await Log.countDocuments(filter)
    const pages = Math.max(1, Math.ceil(total / lim))
    const safePage = Math.min(pg, pages)

    const logs = await Log.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)

    res.json({ logs, total, page: safePage, pages })
  } catch (err) {
    console.error('Log list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function stats(req, res) {
  try {
    const [total, infoCount, warningCount, errorCount] = await Promise.all([
      Log.countDocuments(),
      Log.countDocuments({ level: 'info' }),
      Log.countDocuments({ level: 'warning' }),
      Log.countDocuments({ level: 'error' }),
    ])

    const byCategory = await Log.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])

    res.json({ total, info: infoCount, warning: warningCount, error: errorCount, byCategory })
  } catch (err) {
    console.error('Log stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function clearOld(req, res) {
  try {
    const days = Math.max(1, parseInt(req.query.days, 10) || 30)
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const result = await Log.deleteMany({ createdAt: { $lt: cutoff } })
    res.json({ deleted: result.deletedCount })
  } catch (err) {
    console.error('Log clearOld error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
