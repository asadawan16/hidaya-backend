// A student's leave (client's request, 2026-11-11). Marking a student "On
// leave" can carry a period: leaveStartDate .. leaveEndDate, both inclusive,
// stored date-only (UTC midnight, read in UTC). No end date = open-ended.
// With autoResume on, the student goes back to active the day after
// leaveEndDate (see runLeaveAutoResume in portalStudentController.js).
//
// While on leave the student's classes are not shown on the schedule for
// those days (the slot reads as free), and months whose fee falls due inside
// the leave are not billed automatically.

const dayIso = (d) => {
  if (!d) return ''
  const x = new Date(d)
  return isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10)
}

/** { from, to } as 'YYYY-MM-DD' ('' = open), or null when not on leave. */
export function leaveRange(student) {
  if (student?.status !== 'leave') return null
  return { from: dayIso(student.leaveStartDate), to: dayIso(student.leaveEndDate) }
}

/**
 * Is the student on leave on this day ('YYYY-MM-DD')? `openFrom` is where a
 * leave with no start date begins (the fee code passes today, so a student
 * put on leave before leave dates existed keeps their earlier months billed).
 */
export function isOnLeaveOn(student, iso, { openFrom = '' } = {}) {
  const r = leaveRange(student)
  if (!r) return false
  const from = r.from || openFrom
  if (from && iso < from) return false
  if (r.to && iso > r.to) return false
  return true
}
