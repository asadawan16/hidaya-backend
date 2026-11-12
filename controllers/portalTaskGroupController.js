// Tasks: "Assign to all tutors / staff / students" on the task form.
// Kept apart from portalTaskController.js; the groups are the assignee
// picker's `kind` (GET /portal/tasks/assignees), so everyone is in exactly one.
import User from '../models/User.js'

const KINDS = ['tutor', 'staff', 'student']

// Same split as the picker's kindOf: only the student role → student, only
// the tutor role → tutor, anything else (a tutor who is also a coordinator…) → staff.
const kindOf = (u) => {
  const keys = (u.roles || []).map(r => r.key)
  if (keys.length && keys.every(k => k === 'student')) return 'student'
  if (keys.includes('tutor') && keys.length === 1) return 'tutor'
  return 'staff'
}

// GET /portal/tasks/assignees/everyone?kind=tutor|staff|student — every
// active account of that kind (task.manage).
export async function pickAssigneeGroup(req, res) {
  try {
    const { kind } = req.query
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be tutor, staff or student' })
    const users = await User.find({ status: 'active' })
      .populate('roles', 'key')
      .select('displayName email roles')
      .sort({ displayName: 1 })
      .lean()
    res.json(users.filter(u => kindOf(u) === kind)
      .map(u => ({ _id: u._id, displayName: u.displayName || u.email, email: u.email })))
  } catch (err) {
    console.error('Task assignee group error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
