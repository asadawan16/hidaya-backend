import ClassLink from '../models/ClassLink.js'
import ClassLinkSettings from '../models/ClassLinkSettings.js'
// Registered explicitly: the tutor → userId (avatar) populate below resolves the
// 'TutorProfile' and 'User' models by name, so neither may depend on some other
// route module having been imported first.
import '../models/TutorProfile.js'
import '../models/User.js'

// UNAUTHENTICATED endpoints backing the public /class-links page shared with
// students. Everything here is deliberately read-only and returns ONLY the
// fields a card renders — never tutor emails, phones, ids, salaries or counts.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function to12h(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number)
  if (Number.isNaN(h)) return hhmm || ''
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m || 0).padStart(2, '0')} ${suffix}`
}

// Fallback timing string when the link has no manual `timing` — collapses the
// tutor's shiftWindows into e.g. "Mon–Fri · 8:00 PM – 11:00 PM".
function formatShiftWindows(windows = []) {
  if (!windows.length) return ''
  const sorted = [...windows].sort((a, b) => a.dayOfWeek - b.dayOfWeek)
  const sameTime = sorted.every(w => w.startTime === sorted[0].startTime && w.endTime === sorted[0].endTime)
  const time = `${to12h(sorted[0].startTime)} – ${to12h(sorted[0].endTime)}`

  if (!sameTime) {
    return sorted.map(w => `${SHORT_DAYS[w.dayOfWeek]} ${to12h(w.startTime)}`).join(' · ')
  }
  if (sorted.length === 1) return `${DAYS[sorted[0].dayOfWeek]} · ${time}`
  if (sorted.length === 7) return `Daily · ${time}`

  // Contiguous run of days collapses to a range, otherwise list them.
  const days = sorted.map(w => w.dayOfWeek)
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  const label = contiguous
    ? `${SHORT_DAYS[days[0]]}–${SHORT_DAYS[days[days.length - 1]]}`
    : days.map(d => SHORT_DAYS[d]).join(', ')
  return `${label} · ${time}`
}

export async function getPublicClassLinks(req, res) {
  try {
    const settings = await ClassLinkSettings.getSettings()

    if (!settings.isPublished) {
      return res.json({ published: false, links: [] })
    }

    // Optional access code: a wrong/missing code returns 200 with a flag so the
    // page can render its gate instead of an error screen.
    const required = (settings.accessCode || '').trim()
    if (required) {
      const supplied = String(req.query.code || '').trim()
      if (!supplied || supplied.toLowerCase() !== required.toLowerCase()) {
        return res.json({
          published: true,
          requiresCode: true,
          unlocked: false,
          invalidCode: Boolean(supplied),
          headline: settings.headline,
          subheadline: settings.subheadline,
          links: [],
        })
      }
    }

    const records = await ClassLink.find({ isActive: true })
      .populate({
        path: 'tutor',
        select: 'name subjects roomNo shiftWindows userId',
        populate: { path: 'userId', select: 'avatar' },
      })
      .sort({ order: 1, tutorName: 1 })
      .lean()

    const links = records.map((l, i) => ({
      id: String(l._id),
      tutorName: l.tutorName || l.tutor?.name || 'Tutor',
      url: l.url,
      label: l.label || '',
      platform: l.platform || 'other',
      note: l.note || '',
      timing: l.timing || formatShiftWindows(l.tutor?.shiftWindows),
      subjects: l.tutor?.subjects || [],
      roomNo: l.tutor?.roomNo || '',
      avatar: l.tutor?.userId?.avatar || '',
      theme: Number.isInteger(l.theme) ? l.theme : i % 8,
    }))

    res.json({
      published: true,
      requiresCode: Boolean(required),
      unlocked: true,
      headline: settings.headline,
      subheadline: settings.subheadline,
      links,
    })
  } catch (err) {
    console.error('Public class links error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Fire-and-forget join counter — powers the "joins" column on the manage page.
export async function trackClassLinkClick(req, res) {
  try {
    await ClassLink.updateOne({ _id: req.params.id, isActive: true }, { $inc: { clicks: 1 } })
    res.json({ ok: true })
  } catch {
    res.json({ ok: false })
  }
}
