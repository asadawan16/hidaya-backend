// Fee due dates. Each student's monthly fee falls due on one day of the month:
// `billing.dueDay` when set (1-31), otherwise the day of the month they joined
// (client's request, 2026-11-07: "fees should be based on joining date for
// each student"). A 31st due day lands on the last day of shorter months.
//
// The billing clock is Asia/Karachi, the same boundary the fee grid uses.

const KARACHI = 'Asia/Karachi'

// The monthly fee the grid bills, in the student's billing currency. This
// academy bills its families in USD and records payments in USD, so the
// "Billed amount" (billing.amount, in billing.currency) is the fee. "Fee
// (local)" (billing.fee) is a rupee reference and is used only when no billed
// amount is set; using it made a fully paid $45 month read as 12000 due.
export const monthlyFee = (s) => (s?.billing?.amount > 0 ? s.billing.amount : (s?.billing?.fee || 0))

// Months are billed automatically (from the monthly fee) only from the month
// the academy started keeping fees in the portal. Earlier months show only
// what was recorded by hand, so years of history before the portal don't read
// as owed (client's request, 2026-10-30). Change this to move the start.
export const AUTO_BILL_FROM = { year: 2026, month: 10 }

export function karachiToday(now = new Date()) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: KARACHI, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: KARACHI, hour: '2-digit', hourCycle: 'h23' }).format(now))
  return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)), day: Number(s.slice(8, 10)), iso: s, hour }
}

export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()

// joiningDate is stored date-only (UTC midnight), so its day is read in UTC.
export function dueDayOf(student) {
  const set = Number(student?.billing?.dueDay)
  if (set >= 1 && set <= 31) return set
  const jd = student?.joiningDate || student?.createdAt
  const d = jd ? new Date(jd) : null
  if (d && !isNaN(d.getTime())) return d.getUTCDate()
  return 1
}

export const dueDateIn = (dueDay, year, month) => Math.min(dueDay, daysInMonth(year, month))

const pad = (n) => String(n).padStart(2, '0')
export const isoDate = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`

// 'YYYY-MM-DD' → day number, for date arithmetic without time zones.
export const dayNumber = (iso) => Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000)
export const addDaysIso = (iso, n) => new Date((dayNumber(iso) + n) * 86400000).toISOString().slice(0, 10)

// Has the fee for (year, month) fallen due by `today`?
export function isMonthDue(dueDay, year, month, today) {
  if (year !== today.year || month !== today.month) return year * 12 + month < today.year * 12 + today.month
  return today.day >= dueDateIn(dueDay, year, month)
}

// Colour-hint state for one student month.
//   paid · waived · overdue (past its due date, balance left) · today ·
//   soon (due within SOON_DAYS) · upcoming · none (nothing billed)
export const SOON_DAYS = 3
export function dueStateOf({ amount = 0, paid = 0, waived = false, dueIso, todayIso }) {
  if (waived) return 'waived'
  if (amount > 0 && paid >= amount) return 'paid'
  if (!(amount > 0)) return paid > 0 ? 'paid' : 'none'
  const diff = dayNumber(dueIso) - dayNumber(todayIso)
  if (diff < 0) return 'overdue'
  if (diff === 0) return 'today'
  if (diff <= SOON_DAYS) return 'soon'
  return 'upcoming'
}
