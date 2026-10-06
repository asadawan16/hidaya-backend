/**
 * Student-account scoping.
 *
 * Many portal routes are guarded only by `portalAuth` (self-service things a
 * tutor or staff member does about themselves: check-in, leave, chat), or by a
 * read permission the student role also holds. A student account can reach all
 * of them, and several serve the whole academy. These helpers are how a route
 * says "not for students" or "only this student's own record".
 *
 * A student account = linked to a Student record and holding no role but
 * `student`. A staff member who also happens to be linked to a student keeps
 * their staff access.
 */
export function isStudentAccount(req) {
  if (!req.user?.linkedStudentId) return false
  const keys = (req.user.roles || []).map(r => r?.key).filter(Boolean)
  return keys.length === 0 || keys.every(k => k === 'student')
}

/** Route guard: 403 for student accounts. */
export function denyStudentAccounts(req, res, next) {
  if (isStudentAccount(req)) return res.status(403).json({ error: 'Not available to student accounts' })
  next()
}

/**
 * For routes addressed by a student id: a student account may only ask about
 * itself. Returns true (and has sent the 403) when the request must stop.
 */
export function rejectForeignStudent(req, res, studentId) {
  if (!isStudentAccount(req)) return false
  if (String(studentId) === String(req.user.linkedStudentId)) return false
  res.status(403).json({ error: 'You can only view your own records' })
  return true
}
