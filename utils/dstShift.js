// Daylight-saving shift for the schedule. The academy runs on PKT (no DST), but
// most students live where clocks change, so when their DST flips every class
// moves by an hour on the PKT clock. These helpers do that move while keeping the
// overnight shift-day model intact (see SHIFT_WRAP_HOUR in shiftWindow.js):
// a slot's dayOfWeek is the day its shift STARTS, and 00:00–06:59 is the tail.
import { SHIFT_WRAP_HOUR } from './shiftWindow.js'

export const DST_SHIFT_MINUTES = 60

const mod = (n, m) => ((n % m) + m) % m
const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number)
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null
}
// Same format the session generator writes: no wrap, so an end can read '24:15'.
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

// Move a recurring slot by `delta` minutes. Crossing midnight keeps the shift-day
// (23:30 Mon → 00:30, still Monday's shift); crossing the 7 AM wrap changes it
// (Monday-shift 06:30 → Tuesday 07:30), and the reverse move undoes both exactly.
export function shiftSlotTime(dayOfWeek, startTime, delta) {
  const start = toMin(startTime)
  if (start == null) return null
  const wrap = SHIFT_WRAP_HOUR * 60
  const abs = dayOfWeek * 1440 + start + (start < wrap ? 1440 : 0) + delta
  const min = mod(abs, 1440)
  const physicalDay = Math.floor(abs / 1440)
  const shiftDay = min < wrap ? physicalDay - 1 : physicalDay
  return { dayOfWeek: mod(shiftDay, 7), startTime: fmt(min) }
}

// Move one dated session by `delta` minutes. `date` is midnight-UTC of the PKT
// calendar day the class physically falls on, so a class pushed past midnight
// moves to the next date (and back again on the reverse move).
export function shiftSessionTime(date, scheduledStart, scheduledEnd, delta) {
  const start = toMin(scheduledStart)
  if (start == null) return null
  const end = toMin(scheduledEnd)
  let duration = end == null ? 30 : end - start
  if (duration <= 0) duration += 1440 // stored end already wrapped ('00:15')
  const moved = start + delta
  const dayOffset = Math.floor(moved / 1440)
  const newStart = mod(moved, 1440)
  const newDate = new Date(date)
  newDate.setUTCDate(newDate.getUTCDate() + dayOffset)
  return { date: newDate, scheduledStart: fmt(newStart), scheduledEnd: fmt(newStart + duration) }
}
