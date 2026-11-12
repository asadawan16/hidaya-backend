// Repeating tasks: when one is finished, the next is made from it, due on
// the next date of its pattern (daily / weekly on chosen days / monthly),
// every `interval` days, weeks or months, until `until` if set.
//
// All-day dates are UTC midnights; timed ones keep their time of day.

const DAY = 86400000

export function nextDueDate(task, from = new Date()) {
  const r = task.repeat || {}
  if (!r.freq) return null
  const n = Math.max(1, r.interval || 1)
  const base = task.dueDate ? new Date(task.dueDate) : new Date(from)
  let next
  if (r.freq === 'daily') {
    next = new Date(base.getTime() + n * DAY)
  } else if (r.freq === 'weekly') {
    const days = [...new Set((r.weekdays || []).filter(d => d >= 0 && d <= 6))].sort()
    if (days.length) {
      // The next chosen weekday after the current due date; after the last
      // one in the week, jump `interval` weeks ahead to the first one.
      const wd = base.getUTCDay()
      const later = days.find(d => d > wd)
      if (later != null) next = new Date(base.getTime() + (later - wd) * DAY)
      else next = new Date(base.getTime() + ((7 - wd + days[0]) + (n - 1) * 7) * DAY)
    } else {
      next = new Date(base.getTime() + n * 7 * DAY)
    }
  } else if (r.freq === 'monthly') {
    const day = r.monthDay || base.getUTCDate()
    const y = base.getUTCFullYear(), m = base.getUTCMonth() + n
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    next = new Date(Date.UTC(y, m, Math.min(day, last), base.getUTCHours(), base.getUTCMinutes()))
  } else return null
  // A task finished long after its due date shouldn't spawn one already late:
  // roll forward until the next one is today or later.
  let guard = 0
  const today = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  while (next < today && guard++ < 400) {
    const step = nextDueDate({ ...task, dueDate: next }, new Date(0))
    if (!step || step <= next) break
    next = step
  }
  if (r.until && next > new Date(r.until)) return null
  return next
}

// Fields copied onto the next task in the series.
export function nextTaskFields(task, nextDue) {
  const shift = task.dueDate ? nextDue.getTime() - new Date(task.dueDate).getTime() : 0
  return {
    title: task.title,
    description: task.description,
    type: task.type,
    priority: task.priority,
    status: 'todo',
    allDay: task.allDay,
    dueDate: nextDue,
    startDate: task.startDate ? new Date(new Date(task.startDate).getTime() + shift) : undefined,
    assignees: task.assignees,
    watchers: task.watchers,
    leadId: task.leadId,
    studentId: task.studentId,
    goalId: task.goalId,
    tags: task.tags,
    coachTest: task.coachTest?.scenarioKey ? task.coachTest : undefined,
    checklist: (task.checklist || []).map(i => ({ text: i.text, done: false })),
    repeat: task.repeat,
    repeatOf: task._id,
    createdBy: task.createdBy,
    createdByName: task.createdByName,
    order: task.order,
  }
}
