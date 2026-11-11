/*
 * English Coach — the scripted parts (models/CoachScript.js) and the full
 * scenario list.
 *
 * The conversation scenarios are code (config/coachScenarios.js); the scripted
 * parts are data the admin edits on the Scripts tab. Everything that needs
 * "every scenario" — the Practice tab, starting a call, Settings — asks here.
 * The collection is small (a dozen parts of a few dozen lines), so it is read
 * fresh each time: an edit shows up on the next page load, on every server.
 *
 * The Role-Play Practice Book (config/coachRolePlays.js) is copied in once,
 * the first time anything here runs (ensureBookScripts). Its parts keep their
 * old keys (`book_unit_01`…) so tests taken before the copy, and parts switched
 * off in Settings, still line up.
 */
import crypto from 'node:crypto'
import CoachScript, { SCRIPT_WHO, SCRIPT_STUDENTS, SCRIPT_LIMITS } from '../models/CoachScript.js'
import CoachSettings from '../models/CoachSettings.js'
import { BOOK_UNITS } from '../config/coachRolePlays.js'
import { COACH_SCENARIOS, scriptScenario, getScenario } from '../config/coachScenarios.js'

export const bookKey = (unit) => `book_unit_${String(unit).padStart(2, '0')}`
export const newScriptKey = () => `script_${crypto.randomBytes(5).toString('hex')}`

/** One unit of the book → the fields of its CoachScript. */
export function bookPart(unit) {
  return {
    title: unit.title,
    builtIn: unit.unit,
    plays: unit.plays.map(p => ({
      title: p.title,
      goal: p.goal || '',
      student: p.student || 'S',
      lines: p.lines.map(([who, text, urdu]) => ({ who, text, urdu: who === 'T' ? urdu || '' : '' })),
    })),
  }
}

export const bookUnit = (n) => BOOK_UNITS.find(u => u.unit === n) || null

let seeding = null
/** Copy the book into CoachScript, once per database. Safe to call any number of times. */
export async function ensureBookScripts() {
  const settings = await CoachSettings.getSettings()
  if (settings.scriptsSeededAt) return
  seeding ||= (async () => {
    for (const u of BOOK_UNITS) {
      try {
        await CoachScript.updateOne(
          { key: bookKey(u.unit) },
          { $setOnInsert: { key: bookKey(u.unit), order: u.unit, ...bookPart(u) } },
          { upsert: true },
        )
      } catch (err) {
        if (err?.code !== 11000) throw err // another server inserted it first
      }
    }
    await CoachSettings.updateOne({ key: 'default' }, { $set: { scriptsSeededAt: new Date() } })
  })().finally(() => { seeding = null })
  return seeding
}

/**
 * Every part, in order, in the shape config/coachScenarios.js#scriptScenario
 * takes: `position` is "Part N", and role plays are numbered 1, 2, 3… across
 * all parts, as the book numbers them.
 */
export async function loadParts() {
  await ensureBookScripts()
  const docs = await CoachScript.find().sort({ order: 1, createdAt: 1, _id: 1 }).lean()
  let n = 0
  return docs.map((d, i) => ({
    id: d._id,
    key: d.key,
    position: i + 1,
    title: d.title,
    builtIn: d.builtIn,
    plays: (d.plays || []).map(p => ({
      n: ++n,
      title: p.title,
      goal: p.goal || '',
      student: p.student || 'S',
      lines: (p.lines || []).map(l => [l.who, l.text, l.urdu || '']),
    })),
  }))
}

/** The scripted parts as scenarios (for one scriptMode). */
export async function scriptScenarios(mode = 'english') {
  return (await loadParts()).filter(p => p.plays.length).map(p => scriptScenario(p, mode))
}

/** Every scenario: the scripted parts first, then the conversations. */
export async function allScenarios(mode = 'english') {
  return [...await scriptScenarios(mode), ...COACH_SCENARIOS]
}

/** One scenario by key, or null. */
export async function findScenario(key, mode = 'english') {
  if (typeof key !== 'string' || !key) return null
  const conversation = getScenario(key)
  if (conversation) return conversation
  return (await scriptScenarios(mode)).find(s => s.key === key) || null
}

// ── Validation (the Scripts tab's create / edit) ────────────────────────────
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max + 1)

/**
 * A part as the admin sent it → `{ value }` ready to save, or `{ error }` in a
 * sentence they can act on.
 */
export function validatePart(body) {
  const b = body || {}
  const title = clean(b.title, SCRIPT_LIMITS.title)
  if (!title) return { error: 'Give the part a title.' }
  if (title.length > SCRIPT_LIMITS.title) return { error: `Keep the part's title under ${SCRIPT_LIMITS.title} characters.` }
  if (!Array.isArray(b.plays) || !b.plays.length) return { error: 'Add at least one role play.' }
  if (b.plays.length > SCRIPT_LIMITS.plays) return { error: `A part can have up to ${SCRIPT_LIMITS.plays} role plays.` }

  const plays = []
  for (const [pi, p] of b.plays.entries()) {
    const where = `Role play ${pi + 1}`
    const ptitle = clean(p?.title, SCRIPT_LIMITS.title)
    if (!ptitle) return { error: `${where} needs a title.` }
    if (ptitle.length > SCRIPT_LIMITS.title) return { error: `${where}: keep the title under ${SCRIPT_LIMITS.title} characters.` }
    const goal = clean(p?.goal, SCRIPT_LIMITS.goal)
    if (goal.length > SCRIPT_LIMITS.goal) return { error: `${where}: keep the goal under ${SCRIPT_LIMITS.goal} characters.` }
    const student = SCRIPT_STUDENTS.includes(p?.student) ? p.student : 'S'
    const raw = Array.isArray(p?.lines) ? p.lines : []
    if (!raw.length) return { error: `${where} ("${ptitle}") has no lines.` }
    if (raw.length > SCRIPT_LIMITS.lines) return { error: `${where}: up to ${SCRIPT_LIMITS.lines} lines.` }
    const lines = []
    for (const [li, l] of raw.entries()) {
      const at = `${where}, line ${li + 1}`
      if (!SCRIPT_WHO.includes(l?.who)) return { error: `${at}: choose who says it.` }
      const text = clean(l?.text, SCRIPT_LIMITS.text)
      if (!text) return { error: `${at}: the English line is empty.` }
      if (text.length > SCRIPT_LIMITS.text) return { error: `${at}: keep it under ${SCRIPT_LIMITS.text} characters.` }
      const urdu = l.who === 'T' ? clean(l?.urdu, SCRIPT_LIMITS.urdu) : ''
      if (urdu.length > SCRIPT_LIMITS.urdu) return { error: `${at}: keep the Urdu under ${SCRIPT_LIMITS.urdu} characters.` }
      lines.push({ who: l.who, text, urdu })
    }
    if (!lines.some(l => l.who === 'T')) return { error: `${where} ("${ptitle}") needs at least one teacher line — that is what the tester says.` }
    plays.push({ title: ptitle, goal, student, lines })
  }
  return { value: { title, plays } }
}
