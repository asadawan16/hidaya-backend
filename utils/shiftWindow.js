/**
 * Check if the current time falls within any of the tutor's shift windows.
 * Uses Intl.DateTimeFormat for timezone conversion — no extra packages needed.
 *
 * @param {Array} shiftWindows - [{ dayOfWeek: 0-6, startTime: 'HH:MM', endTime: 'HH:MM' }]
 * @param {string} timezone - IANA timezone string (e.g. 'Asia/Karachi')
 * @param {number} graceMinutes - grace period before/after shift (default 15)
 * @returns {boolean}
 */
export function isWithinShiftWindow(shiftWindows, timezone, graceMinutes = 15) {
  if (!shiftWindows || shiftWindows.length === 0) return true

  const now = new Date()
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
  })

  const parts = formatter.formatToParts(now)
  const weekdayStr = parts.find(p => p.type === 'weekday')?.value
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value, 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value, 10)

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const currentDay = dayMap[weekdayStr]
  // Intl with hour12:false can emit '24' at midnight — normalise to 0
  const currentMinutes = (hour % 24) * 60 + minute

  return shiftWindows.some(w => {
    if (w.dayOfWeek !== currentDay) return false
    const [sh, sm] = (w.startTime || '').split(':').map(Number)
    const [eh, em] = (w.endTime || '').split(':').map(Number)
    if ([sh, sm, eh, em].some(Number.isNaN)) return false
    const shiftStart = sh * 60 + sm - graceMinutes
    const shiftEnd = eh * 60 + em + graceMinutes
    return currentMinutes >= shiftStart && currentMinutes <= shiftEnd
  })
}
