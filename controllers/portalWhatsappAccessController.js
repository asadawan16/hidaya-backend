import mongoose from 'mongoose'
import User from '../models/User.js'
import TutorProfile from '../models/TutorProfile.js'
import Assignment from '../models/Assignment.js'
import { emitToUser, setUserRoom } from '../config/socket.js'
import { effectivePermissions } from '../middleware/portalAuth.js'
import { isStudentAccount } from '../middleware/studentScope.js'
import { logActivity } from '../utils/activityLogger.js'
import {
  CHAT_LEVELS, CHAT_PERMISSIONS, LEVEL_PERMISSIONS, chatLevel, canUseChats,
} from '../utils/whatsappAccess.js'

/*
 * WhatsApp page → Team access (whatsapp.manage). One row per staff member and
 * tutor: their WhatsApp Chats level and whether they can send class reminders.
 *
 * Per-person levels live in User.extraPermissions. A role can grant a level
 * too (Roles page); the person gets the higher of the two, so a role grant
 * shows here as a floor the person can't be set below.
 *
 * Reminders keep their own switch (PUT /reminders/access) — this controller
 * only reports them, so the panel can show both in one list.
 */

const REMINDER_PERM = 'whatsapp.reminder'
const LEVEL_LABEL = { none: 'no access', own: 'own students', all: 'all chats', full: 'full inbox' }

function rolePermissions(user) {
  return new Set((user.roles || []).flatMap(r => r.permissions || []))
}

// GET /portal/whatsapp/access
export async function listTeamAccess(_req, res) {
  try {
    const [users, profiles] = await Promise.all([
      User.find({})
        .select('displayName email status roles linkedTutorId linkedStudentId extraPermissions')
        .populate('roles', 'key name permissions')
        .lean(),
      TutorProfile.find({}).select('name tutorId status userId').lean(),
    ])
    const byId = new Map(profiles.map(p => [String(p._id), p]))
    const byUser = new Map(profiles.filter(p => p.userId).map(p => [String(p.userId), p]))

    // How many students each tutor would see at the own-students level
    const counts = await Assignment.aggregate([
      { $match: { endDate: null, approvalStatus: { $in: ['auto_approved', 'approved'] } } },
      { $group: { _id: '$tutorId', students: { $addToSet: '$studentId' } } },
      { $project: { n: { $size: '$students' } } },
    ])
    const studentCount = new Map(counts.map(c => [String(c._id), c.n]))

    const rows = []
    for (const u of users) {
      if (isStudentAccount({ user: u })) continue
      const tutor = (u.linkedTutorId && byId.get(String(u.linkedTutorId))) || byUser.get(String(u._id)) || null
      const fromRoles = rolePermissions(u)
      const extras = u.extraPermissions || []
      rows.push({
        _id: u._id,
        displayName: u.displayName,
        email: u.email,
        status: u.status,
        roles: (u.roles || []).map(r => ({ key: r.key, name: r.name || r.key })),
        tutor: tutor ? { name: tutor.name, tutorId: tutor.tutorId || '', status: tutor.status, students: studentCount.get(String(tutor._id)) || 0 } : null,
        chat: {
          level: chatLevel(effectivePermissions(u)),
          personal: chatLevel(extras),
          fromRole: chatLevel(fromRoles),
        },
        reminder: { on: extras.includes(REMINDER_PERM) || fromRoles.has(REMINDER_PERM), viaRole: fromRoles.has(REMINDER_PERM) },
      })
    }
    rows.sort((a, b) => (a.tutor?.name || a.displayName || '').localeCompare(b.tutor?.name || b.displayName || ''))
    res.json({ users: rows, levels: CHAT_LEVELS })
  } catch (err) {
    console.error('List WhatsApp team access error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// PUT /portal/whatsapp/access — { userIds: [...], level: 'none' | 'own' | 'all' | 'full' }
export async function setTeamAccess(req, res) {
  const { userIds, level } = req.body || {}
  if (!CHAT_LEVELS.includes(level)) return res.status(400).json({ error: 'Choose an access level' })
  if (!Array.isArray(userIds) || !userIds.length || userIds.length > 500 || !userIds.every(id => mongoose.isValidObjectId(id))) {
    return res.status(400).json({ error: 'Choose at least one person' })
  }
  try {
    const users = await User.find({ _id: { $in: userIds } })
      .select('displayName linkedTutorId linkedStudentId roles extraPermissions')
      .populate('roles', 'key permissions')
      .lean()
    const tutorUserIds = new Set((await TutorProfile.find({ userId: { $in: users.map(u => u._id) } }).select('userId').lean()).map(p => String(p.userId)))

    const skipped = []
    const writes = []
    const changed = []
    for (const u of users) {
      // Clearing is always allowed, so a stray grant can be cleaned up
      if (level !== 'none') {
        if (isStudentAccount({ user: u })) { skipped.push({ _id: u._id, displayName: u.displayName, reason: 'Student account' }); continue }
        if (level === 'own' && !u.linkedTutorId && !tutorUserIds.has(String(u._id))) {
          skipped.push({ _id: u._id, displayName: u.displayName, reason: 'Not linked to a tutor profile, so there are no own students to show' })
          continue
        }
      }
      const extras = [...(u.extraPermissions || []).filter(p => !CHAT_PERMISSIONS.includes(p)), ...LEVEL_PERMISSIONS[level]]
      writes.push({ updateOne: { filter: { _id: u._id }, update: { $set: { extraPermissions: extras } } } })
      changed.push({ ...u, extraPermissions: extras })
    }
    if (writes.length) await User.bulkWrite(writes)

    for (const u of changed) {
      const id = String(u._id)
      // Open tabs re-read /me (nav item, page access) and join or leave the live-updates room
      emitToUser(id, 'permissions_changed', { permission: 'whatsapp.chat', level })
      setUserRoom(id, 'whatsapp-chats', canUseChats(effectivePermissions(u)))
    }
    if (changed.length) {
      await logActivity({
        level: 'info', category: 'portal', action: 'whatsapp_chat_access_changed',
        message: `WhatsApp Chats set to ${LEVEL_LABEL[level]} for ${changed.map(u => u.displayName).join(', ')}`, req,
        meta: { userIds: changed.map(u => u._id), level },
      })
    }
    res.json({ updated: changed.length, skipped })
  } catch (err) {
    console.error('Set WhatsApp team access error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
