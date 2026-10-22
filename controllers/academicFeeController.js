import AcademicFeeSettings, { DEFAULT_ACADEMIC_FEES, FEE_CURRENCIES } from '../models/AcademicFeeSettings.js'
import { logActivity } from '../utils/activityLogger.js'

async function loadSettings() {
  const doc = await AcademicFeeSettings.findOne({ key: 'default' }).lean()
  return doc || { ...DEFAULT_ACADEMIC_FEES }
}

function cleanPrices(perClass = {}) {
  const out = {}
  for (const c of FEE_CURRENCIES) {
    const v = perClass?.[c]
    if (v === '' || v == null) continue
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0 && n <= 10000) out[c] = Math.round(n * 100) / 100
  }
  return out
}

// ─── Public: GET /api/academic-fees ───
// Prices leave the server only when showPrices is on.
export async function getPublic(req, res) {
  try {
    const s = await loadSettings()
    res.set('Cache-Control', 'public, max-age=60')
    res.json({
      showPrices: !!s.showPrices,
      minutes: s.minutes,
      schedules: s.schedules,
      footnote: s.footnote,
      bands: (s.bands || []).map((b) => ({
        key: b.key,
        title: b.title,
        range: b.range,
        recommended: b.recommended,
        note: b.note,
        ...(s.showPrices ? { perClass: cleanPrices(b.perClass) } : {}),
      })),
    })
  } catch (err) {
    console.error('Academic fees (public) error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Portal: GET /portal/billing/academic-fees ───
export async function getSettings(req, res) {
  try {
    res.json(await loadSettings())
  } catch (err) {
    console.error('Academic fees (portal) error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Portal: PUT /portal/billing/academic-fees ───
export async function updateSettings(req, res) {
  try {
    const body = req.body || {}

    const schedules = [...new Set((Array.isArray(body.schedules) ? body.schedules : [])
      .map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort((a, b) => a - b)
    if (!schedules.length || schedules.length > 5) {
      return res.status(400).json({ error: 'Give 1 to 5 "classes a week" options, each between 1 and 7' })
    }

    const minutes = Number(body.minutes)
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 180) {
      return res.status(400).json({ error: 'Class length must be between 15 and 180 minutes' })
    }

    const rawBands = Array.isArray(body.bands) ? body.bands : []
    if (!rawBands.length || rawBands.length > 8) {
      return res.status(400).json({ error: 'Add between 1 and 8 grade bands' })
    }
    const seen = new Set()
    const bands = []
    for (const [i, b] of rawBands.entries()) {
      const title = typeof b?.title === 'string' ? b.title.trim() : ''
      if (!title) return res.status(400).json({ error: `Grade band ${i + 1} needs a name` })
      let key = (typeof b.key === 'string' && b.key.trim()) || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `band-${i + 1}`
      while (seen.has(key)) key = `${key}-${i + 1}`
      seen.add(key)
      const rec = Number(b.recommended)
      bands.push({
        key: key.slice(0, 40),
        title: title.slice(0, 60),
        range: typeof b.range === 'string' ? b.range.trim().slice(0, 60) : '',
        recommended: schedules.includes(rec) ? rec : undefined,
        note: typeof b.note === 'string' ? b.note.trim().slice(0, 200) : '',
        perClass: cleanPrices(b.perClass),
      })
    }

    const doc = await AcademicFeeSettings.findOneAndUpdate(
      { key: 'default' },
      {
        $set: {
          showPrices: !!body.showPrices,
          minutes,
          schedules,
          footnote: typeof body.footnote === 'string' ? body.footnote.trim().slice(0, 300) : '',
          bands,
          updatedBy: req.userId,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean()

    await logActivity({
      level: 'info', category: 'billing', action: 'academic_fees_updated',
      message: `Academic fees updated (prices ${doc.showPrices ? 'shown' : 'hidden'} on the website)`, req,
    })

    res.json(doc)
  } catch (err) {
    console.error('Academic fees update error:', err)
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message })
    res.status(500).json({ error: 'Server error' })
  }
}
