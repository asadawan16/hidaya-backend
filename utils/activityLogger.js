import Log from '../models/Log.js'

export async function logActivity({ level = 'info', category, action, message, req, meta }) {
  try {
    await Log.create({
      level,
      category,
      action,
      message,
      method: req?.method,
      path: req?.path || req?.url,
      ip: req?.ip || req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress,
      adminId: req?.adminId || null,
      meta,
    })
  } catch {
    // Never let logging failures break the app
  }
}
