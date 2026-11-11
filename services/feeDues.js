// Fee dues by day — every student month whose due date falls in a window,
// plus everything already past due and unpaid. One walk over the same rules as
// the fee grid (saved cells win; months without a cell are billed from the
// monthly fee from AUTO_BILL_FROM and the joining month on), so the "Due by
// day" view, the dashboard card and the reminder notifications can't disagree.
import Student from '../models/Student.js'
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import '../models/Family.js'
import {
  AUTO_BILL_FROM, monthlyFee, karachiToday, dueDayOf, dueDateIn, isoDate, dueStateOf, addDaysIso,
} from '../utils/feeDue.js'
import { getRates } from './currencyRates.js'
import { isOnLeaveOn } from '../utils/studentLeave.js'

const AUTO_BILL_KEY = AUTO_BILL_FROM.year * 12 + (AUTO_BILL_FROM.month - 1)
const keyOf = (y, m) => y * 12 + (m - 1)
const ymOf = (k) => ({ year: Math.floor(k / 12), month: (k % 12) + 1 })

function joinKeyOf(s) {
  const jd = s.joiningDate || s.createdAt
  const d = jd ? new Date(jd) : null
  if (!d || isNaN(d.getTime())) return 0
  return keyOf(d.getUTCFullYear(), d.getUTCMonth() + 1)
}

/**
 * @param {object} o
 * @param {string} o.fromIso  first due date to list (YYYY-MM-DD)
 * @param {string} o.toIso    last due date to list
 * @param {boolean} [o.includeOverdue=true]  also return unpaid months due before fromIso (and before today)
 * @param {string[]} [o.studentIds]  limit to these students
 */
export async function collectDues({ fromIso, toIso, includeOverdue = true, studentIds } = {}) {
  const today = karachiToday()
  const filter = { status: { $ne: 'left' } }
  if (studentIds?.length) filter._id = { $in: studentIds }
  const students = await Student.find(filter)
    .select('name rollNo status familyId billing joiningDate createdAt userId leaveStartDate leaveEndDate')
    .populate('familyId', 'familyCode')
    .lean()
  const ids = students.map(s => s._id)

  const endKey = keyOf(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)))
  const cells = await StudentFeeRecord.find({ studentId: { $in: ids } }).lean()
  const cellsByStudent = new Map()
  for (const c of cells) {
    const k = String(c.studentId)
    if (!cellsByStudent.has(k)) cellsByStudent.set(k, new Map())
    cellsByStudent.get(k).set(keyOf(c.year, c.month), c)
  }

  const items = []
  const overdue = []
  for (const s of students) {
    const dueDay = dueDayOf(s)
    const baseFee = monthlyFee(s)
    const currency = s.billing?.currency || 'PKR'
    const myCells = cellsByStudent.get(String(s._id)) || new Map()
    const autoStart = Math.max(AUTO_BILL_KEY, joinKeyOf(s))
    let startKey = autoStart
    for (const k of myCells.keys()) if (k < startKey) startKey = k

    for (let k = startKey; k <= endKey; k++) {
      const { year, month } = ymOf(k)
      const cell = myCells.get(k)
      let amount, paid, waived, cur, auto
      const dueIso = isoDate(year, month, dueDateIn(dueDay, year, month))
      if (cell) {
        amount = cell.amount || 0
        paid = cell.amountPaid || 0
        waived = cell.status === 'waived'
        cur = currency // month amounts are in the student's billing currency
        auto = false
        if (!amount && !paid) continue
      } else if (k >= autoStart && baseFee > 0 && !isOnLeaveOn(s, dueIso, { openFrom: today.iso })) {
        // A month whose fee falls due while the student is on leave isn't billed.
        amount = baseFee; paid = 0; waived = false; cur = currency; auto = true
      } else continue

      const state = dueStateOf({ amount, paid, waived, dueIso, todayIso: today.iso })
      const row = {
        studentId: s._id,
        name: s.name,
        rollNo: s.rollNo || '',
        studentStatus: s.status,
        familyCode: s.familyId?.familyCode || '',
        userId: s.userId || null,
        year, month, dueDay, dueDate: dueIso,
        amount, paid, balance: Math.max(0, amount - paid), currency: cur,
        state, auto,
      }
      if (dueIso >= fromIso && dueIso <= toIso) items.push(row)
      else if (includeOverdue && dueIso < fromIso && state === 'overdue') overdue.push(row)
    }
  }

  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name))
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name))
  return { today, items, overdue }
}

// [{ currency, amount, count, pkr }] + pkrTotal, from each row's `field`.
export async function totalsByCurrency(rows, field = 'balance') {
  const rates = await getRates()
  const map = new Map()
  for (const r of rows) {
    const v = r[field] || 0
    if (!v) continue
    const t = map.get(r.currency) || { currency: r.currency, amount: 0, count: 0, pkr: 0, rate: rates[r.currency] || 1 }
    t.amount += v
    t.count += 1
    t.pkr += v * (rates[r.currency] || 1)
    map.set(r.currency, t)
  }
  const list = [...map.values()].sort((a, b) => b.pkr - a.pkr)
  return { list, pkrTotal: Math.round(list.reduce((s, t) => s + t.pkr, 0)) }
}

// Dashboard + reminder summary: unpaid months due today, overdue, and due in
// the next `days` days (tomorrow onward).
export async function duesSummary({ days = 7 } = {}) {
  const today = karachiToday()
  const toIso = addDaysIso(today.iso, days)
  const { items, overdue } = await collectDues({ fromIso: today.iso, toIso })
  const unpaid = items.filter(r => r.balance > 0 && r.state !== 'waived')
  const dueToday = unpaid.filter(r => r.dueDate === today.iso)
  const tomorrowIso = addDaysIso(today.iso, 1)
  const dueTomorrow = unpaid.filter(r => r.dueDate === tomorrowIso)
  const upcoming = unpaid.filter(r => r.dueDate > today.iso)
  const [todayT, overdueT, upcomingT, tomorrowT] = await Promise.all([
    totalsByCurrency(dueToday), totalsByCurrency(overdue), totalsByCurrency(upcoming), totalsByCurrency(dueTomorrow),
  ])
  const allPending = await totalsByCurrency([...dueToday, ...overdue, ...upcoming])
  return {
    today: today.iso,
    tomorrow: tomorrowIso,
    days,
    dueToday, overdue, upcoming, dueTomorrow,
    totals: { today: todayT, overdue: overdueT, upcoming: upcomingT, tomorrow: tomorrowT, pending: allPending },
  }
}
