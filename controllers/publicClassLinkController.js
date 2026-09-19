import ClassLink from '../models/ClassLink.js'
import ClassLinkSettings from '../models/ClassLinkSettings.js'
import StudentClassLink from '../models/StudentClassLink.js'
import '../models/Student.js'
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

/* ── Per-student links (/my-class/:token) ──────────────────────────────────
 * One student, one page, one Join button — so nobody has to work out which of
 * fifteen tutor cards is theirs. The token IS the credential, so this endpoint
 * is not behind the board's access code; it returns only the fields that page
 * renders, and never the student's contacts, guardians, fees or ids.
 */

// A null theme still has to look the same on every visit, so it's derived from
// the token rather than from the request.
function themeFromToken(token) {
  let sum = 0
  for (let i = 0; i < token.length; i++) sum += token.charCodeAt(i)
  return sum % 8
}

// First name only — "Assalamu alaikum, Muhammad" reads like a greeting where
// the full three-part registered name reads like a register.
function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || ''
}

/**
 * Tokens are roll numbers now (`/my-class/hid518`), so they get typed by hand
 * and shouted down a phone — and half the academy writes the roll number as
 * HID518. The indexed exact match runs first and answers every link that was
 * actually clicked; the anchored case-insensitive regex is the fallback that
 * rescues a hand-typed one, and it only ever runs on a miss.
 */
async function findByToken(token) {
  const exact = await StudentClassLink.findOne({ token })
    .populate('student', 'name courseLabels')
    .lean()
  if (exact) return exact

  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return StudentClassLink.findOne({ token: new RegExp(`^${escaped}$`, 'i') })
    .populate('student', 'name courseLabels')
    .lean()
}

export async function getPublicStudentClassLink(req, res) {
  try {
    const token = String(req.params.token || '').trim()
    // A miss is a 200 with found:false, not a 404 — the page renders a calm
    // "check the link" card instead of an error screen.
    if (!token) return res.json({ found: false })

    const link = await findByToken(token)

    if (!link) return res.json({ found: false })

    if (!link.isActive) {
      return res.json({ found: true, active: false, firstName: firstNameOf(link.studentName) })
    }

    res.json({
      found: true,
      active: true,
      id: String(link._id),
      studentName: link.studentName,
      firstName: firstNameOf(link.studentName),
      // Shown on the card so the page confirms whose it is — the same roll
      // number that now addresses it in the URL.
      rollNo: link.rollNo || '',
      url: link.url,
      label: link.label || '',
      tutorName: link.tutorName || '',
      platform: link.platform || 'other',
      timing: link.timing || '',
      note: link.note || '',
      courses: link.student?.courseLabels || [],
      theme: Number.isInteger(link.theme) ? link.theme : themeFromToken(token),
    })
  } catch (err) {
    console.error('Public student class link error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function trackStudentClassLinkClick(req, res) {
  try {
    const token = String(req.params.token || '').trim()
    // Matched the same way the page itself was, or a page reached by a
    // hand-typed HID518 would render but never count its joins.
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await StudentClassLink.updateOne(
      { token: new RegExp(`^${escaped}$`, 'i'), isActive: true },
      { $inc: { clicks: 1 }, $set: { lastClickedAt: new Date() } },
    )
    res.json({ ok: true })
  } catch {
    res.json({ ok: false })
  }
}
