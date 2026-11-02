import Assignment from '../models/Assignment.js'
import TutorProfile from '../models/TutorProfile.js'

/*
 * Who may use WhatsApp Chats (/portal/whatsapp-chats), and how much of it.
 *
 *   none   —
 *   own    whatsapp.chat_own          chats of the tutor's own students only
 *   all    whatsapp.chat              every chat
 *   full   whatsapp.chat + .inbox     every chat, numbers, fee messages, files, templates
 *
 * `own` and `all` are the staff view (number never sent, fee messages hidden).
 * A level can come from a role (Roles page) or be given to one person
 * (User.extraPermissions, WhatsApp page → Team access); a person gets the
 * higher of the two, because permissions only ever add up.
 */

export const CHAT_LEVELS = ['none', 'own', 'all', 'full']
export const CHAT_PERMISSIONS = ['whatsapp.chat_own', 'whatsapp.chat', 'whatsapp.inbox']
export const LEVEL_PERMISSIONS = {
  none: [],
  own: ['whatsapp.chat_own'],
  all: ['whatsapp.chat'],
  full: ['whatsapp.chat', 'whatsapp.inbox'],
}

export function chatLevel(perms) {
  const has = (p) => (perms instanceof Set ? perms.has(p) : (perms || []).includes(p))
  if (has('whatsapp.chat') && has('whatsapp.inbox')) return 'full'
  if (has('whatsapp.chat')) return 'all'
  if (has('whatsapp.chat_own')) return 'own'
  return 'none'
}

export const canUseChats = (perms) => chatLevel(perms) !== 'none'

// The tutor profile behind a portal user (linked explicitly, or by userId)
export async function tutorProfileIdOf(user) {
  if (!user) return null
  const linked = user.linkedTutorId?._id || user.linkedTutorId
  if (linked) return linked
  return (await TutorProfile.findOne({ userId: user._id }).select('_id').lean())?._id || null
}

// The students whose chats an `own`-level user may open: those currently
// assigned to them (temporary cover included, requests still awaiting approval not)
export async function ownStudentIds(user) {
  const tutorId = await tutorProfileIdOf(user)
  if (!tutorId) return []
  return Assignment.distinct('studentId', {
    tutorId, endDate: null, approvalStatus: { $in: ['auto_approved', 'approved'] },
  })
}

/**
 * Which chats this request may see: null = all of them, otherwise the list of
 * student ids (an empty list = none). Cached on the request.
 */
export async function chatScope(req) {
  if (chatLevel(req.userPermissions) !== 'own') return null
  if (!req.whatsappScope) req.whatsappScope = (await ownStudentIds(req.user)).map(String)
  return req.whatsappScope
}

export const inScope = (scope, studentId) => scope === null || (!!studentId && scope.includes(String(studentId)))
