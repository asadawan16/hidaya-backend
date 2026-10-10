import User from '../models/User.js'

// Staff Employee IDs: E01, E02, … — the staff counterpart of a tutor's T01.
// Stored on User.employeeId (unique while set).

const AUTO_ID = /^E(\d+)$/
const MISSING = { employeeId: { $in: [null, ''] } }

// Normalize a user-supplied employee ID (uppercase, trimmed). Returns '' if blank.
export function normalizeEmployeeId(raw) {
  return String(raw || '').trim().toUpperCase()
}

export const isValidEmployeeId = (id) => /^[A-Z0-9][A-Z0-9-]{0,19}$/.test(id)

// Highest number already used by an auto-format ID (numeric, so E100 > E99).
async function highestAutoNumber() {
  const taken = await User.find({ employeeId: { $regex: /^E\d+$/ } }).select('employeeId').lean()
  return taken.reduce((max, u) => Math.max(max, Number(AUTO_ID.exec(u.employeeId)?.[1]) || 0), 0)
}

/**
 * Give every user matching `filter` an Employee ID if they don't have one yet.
 * Oldest account first, so the numbering follows the order people joined.
 *
 * Staff aren't created through one code path (a user becomes "staff" by the
 * roles they hold), so the staff list and the payroll roster call this before
 * they read — a cheap no-op once everyone is numbered. The unique index is the
 * guard against two requests racing for the same number: the loser re-reads the
 * highest number and tries again.
 */
export async function ensureEmployeeIds(filter) {
  const missing = await User.find({ $and: [filter, MISSING] })
    .select('_id').sort({ createdAt: 1, _id: 1 }).lean()
  if (!missing.length) return 0

  let next = (await highestAutoNumber()) + 1
  let assigned = 0
  for (const u of missing) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await User.updateOne(
          { _id: u._id, ...MISSING },
          { $set: { employeeId: `E${String(next).padStart(2, '0')}` } },
        )
        // matchedCount 0 = another request numbered this user first; nothing to do.
        if (res.matchedCount) { assigned++; next++ }
        break
      } catch (err) {
        if (err?.code !== 11000) throw err
        next = (await highestAutoNumber()) + 1
      }
    }
  }
  return assigned
}
