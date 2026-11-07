// Fee reminders as portal notifications (bell + push): the day before fees
// fall due, and a daily digest of what is due today and still pending, each
// totalled in its own currency. Settings: models/FeeReminderSettings.js.
import FeeReminderSettings from '../models/FeeReminderSettings.js'
import User from '../models/User.js'
import { createNotification, notifyRoles } from '../controllers/portalNotificationController.js'
import { duesSummary } from './feeDues.js'
import { karachiToday } from '../utils/feeDue.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const money = (amount, cur) => `${cur} ${Number(amount || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const currencyLine = (totals) => totals.list.map(t => money(t.amount, t.currency)).join(' · ') || 'nothing'
const dayLabel = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`
const names = (rows, n = 6) => {
  const list = rows.slice(0, n).map(r => `${r.name} (${money(r.balance, r.currency)})`)
  return list.join(', ') + (rows.length > n ? ` and ${rows.length - n} more` : '')
}

export async function getReminderSettings() {
  return (await FeeReminderSettings.findOne({ key: 'default' }))
    || FeeReminderSettings.create({ key: 'default' })
}

export async function sendDayBeforeReminder(settings) {
  const s = settings || await getReminderSettings()
  const sum = await duesSummary({ days: 1 })
  const rows = sum.dueTomorrow
  if (rows.length) {
    await notifyRoles(s.recipientRoles, {
      type: 'fee_due_tomorrow',
      title: `${rows.length} fee${rows.length === 1 ? '' : 's'} due tomorrow (${dayLabel(sum.tomorrow)})`,
      body: `${currencyLine(sum.totals.tomorrow)} — ${names(rows)}`,
      payload: { date: sum.tomorrow, view: 'dues' },
    })
  }
  let students = 0
  if (s.notifyStudents) {
    for (const r of rows) {
      const userId = r.userId || (await User.findOne({ linkedStudentId: r.studentId, status: 'active' }).select('_id').lean())?._id
      if (!userId) continue
      await createNotification({
        userId,
        type: 'fee_due_student',
        title: `Your ${MONTHS[r.month - 1]} fee is due tomorrow`,
        body: `${money(r.balance, r.currency)} is due on ${dayLabel(r.dueDate)}.`,
        payload: { date: r.dueDate },
      })
      students++
    }
  }
  return { sent: rows.length, students, date: sum.tomorrow }
}

export async function sendDailyDigest(settings) {
  const s = settings || await getReminderSettings()
  const sum = await duesSummary({ days: 7 })
  const { dueToday, overdue } = sum
  if (!dueToday.length && !overdue.length) return { sent: 0, date: sum.today }
  const parts = []
  if (dueToday.length) parts.push(`Due today: ${currencyLine(sum.totals.today)} (${names(dueToday, 4)})`)
  if (overdue.length) parts.push(`Pending: ${currencyLine(sum.totals.overdue)} across ${overdue.length} month${overdue.length === 1 ? '' : 's'}`)
  const pkr = sum.totals.today.pkrTotal + sum.totals.overdue.pkrTotal
  parts.push(`≈ PKR ${pkr.toLocaleString('en-US')} in all`)
  await notifyRoles(s.recipientRoles, {
    type: 'fee_digest',
    title: `Fees today: ${dueToday.length} due · ${overdue.length} pending`,
    body: parts.join('. '),
    payload: { date: sum.today, view: 'dues' },
  })
  return { sent: dueToday.length + overdue.length, date: sum.today }
}

// Background job: once a day, from settings.sendHour (Pakistan time).
let running = false
export async function runFeeReminders() {
  if (running) return
  running = true
  try {
    const s = await getReminderSettings()
    const today = karachiToday()
    if (today.hour < s.sendHour) return
    if (s.dayBefore && s.lastDayBeforeOn !== today.iso) {
      // Mark first: a crash halfway must not spam everyone on the next tick.
      await FeeReminderSettings.updateOne({ _id: s._id }, { lastDayBeforeOn: today.iso })
      await sendDayBeforeReminder(s)
    }
    if (s.dailyDigest && s.lastDigestOn !== today.iso) {
      await FeeReminderSettings.updateOne({ _id: s._id }, { lastDigestOn: today.iso })
      await sendDailyDigest(s)
    }
  } catch (err) {
    console.error('Fee reminders job error:', err.message)
  } finally {
    running = false
  }
}
