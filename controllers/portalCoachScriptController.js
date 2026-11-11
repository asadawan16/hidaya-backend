/*
 * English Coach — the Scripts tab (coach.manage): the word-for-word parts
 * testers practise (models/CoachScript.js), and how they run for everyone
 * (CoachSettings.scriptMode, saved through PUT /portal/coach/settings).
 *
 *   GET    /scripts               every part with its lines, in order
 *   POST   /scripts               a new part
 *   PUT    /scripts/:scriptId     replace a part's title and role plays
 *   DELETE /scripts/:scriptId     remove a part (tests already taken keep their copy)
 *   POST   /scripts/:scriptId/restore  a part from the book → the book's wording again
 *   POST   /scripts/restore-book  put back any of the book's parts that were deleted
 *   PUT    /scripts/order         { ids: [...] } — the order on the Practice tab
 *
 * A call stores its own snapshot of the lines (CoachSession.script), so none
 * of this changes a test already taken or one in progress.
 */
import mongoose from 'mongoose'
import CoachScript from '../models/CoachScript.js'
import CoachSession from '../models/CoachSession.js'
import CoachSettings from '../models/CoachSettings.js'
import { BOOK_UNITS } from '../config/coachRolePlays.js'
import { ensureBookScripts, loadParts, validatePart, bookKey, bookPart, bookUnit, newScriptKey } from '../services/coachScripts.js'
import { logActivity } from '../utils/activityLogger.js'

const isId = (id) => mongoose.isValidObjectId(id)

async function scriptsView() {
  const [parts, settings, used] = await Promise.all([
    loadParts(),
    CoachSettings.getSettings(),
    CoachSession.aggregate([
      { $match: { 'scenario.kind': 'script', status: { $ne: 'abandoned' } } },
      { $group: { _id: '$scenarioKey', tests: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
    ]),
  ])
  const usage = new Map(used.map(u => [u._id, u]))
  const off = new Set(settings.disabledScenarios || [])
  const present = new Set(parts.map(p => p.builtIn).filter(Boolean))
  return {
    scriptMode: settings.scriptMode || 'english',
    items: parts.map(p => {
      const lines = p.plays.flatMap(pl => pl.lines)
      const teacher = lines.filter(([w]) => w === 'T')
      return {
        id: p.id,
        key: p.key,
        position: p.position,
        title: p.title,
        builtIn: p.builtIn || null,
        enabled: !off.has(p.key),
        tests: usage.get(p.key)?.tests || 0,
        lastTestAt: usage.get(p.key)?.lastAt || null,
        counts: { plays: p.plays.length, lines: lines.length, teacher: teacher.length, urdu: teacher.filter(l => l[2]).length },
        plays: p.plays.map(pl => ({
          n: pl.n, title: pl.title, goal: pl.goal, student: pl.student,
          lines: pl.lines.map(([who, text, urdu]) => ({ who, text, urdu })),
        })),
      }
    }),
    // The book's parts that are not in the list any more (Restore brings them back)
    missingBook: BOOK_UNITS.filter(u => !present.has(u.unit)).map(u => ({ unit: u.unit, title: u.title })),
  }
}

const fail = (res, label) => (err) => {
  console.error(`English Coach scripts (${label}):`, err)
  res.status(500).json({ error: 'Server error' })
}

export async function listScripts(req, res) {
  try {
    res.json(await scriptsView())
  } catch (err) { fail(res, 'list')(err) }
}

export async function createScript(req, res) {
  try {
    const { value, error } = validatePart(req.body)
    if (error) return res.status(400).json({ error })
    await ensureBookScripts()
    const last = await CoachScript.findOne().sort({ order: -1 }).select('order').lean()
    const doc = await CoachScript.create({ ...value, key: newScriptKey(), order: (last?.order ?? 0) + 1, createdBy: req.userId, updatedBy: req.userId })
    logActivity({ category: 'portal', action: 'english_coach_script_create', message: `Added English Coach script "${doc.title}"`, req, meta: { scriptId: String(doc._id), key: doc.key } })
    res.status(201).json({ id: doc._id, ...await scriptsView() })
  } catch (err) { fail(res, 'create')(err) }
}

export async function updateScript(req, res) {
  try {
    if (!isId(req.params.scriptId)) return res.status(404).json({ error: 'Script not found' })
    const { value, error } = validatePart(req.body)
    if (error) return res.status(400).json({ error })
    const doc = await CoachScript.findByIdAndUpdate(req.params.scriptId, { $set: { ...value, updatedBy: req.userId } }, { new: true })
    if (!doc) return res.status(404).json({ error: 'Script not found' })
    logActivity({ category: 'portal', action: 'english_coach_script_update', message: `Edited English Coach script "${doc.title}"`, req, meta: { scriptId: String(doc._id), key: doc.key } })
    res.json(await scriptsView())
  } catch (err) { fail(res, 'update')(err) }
}

export async function deleteScript(req, res) {
  try {
    if (!isId(req.params.scriptId)) return res.status(404).json({ error: 'Script not found' })
    if (await CoachScript.countDocuments() <= 1) return res.status(400).json({ error: 'Keep at least one script. Add another before deleting this one.' })
    const doc = await CoachScript.findByIdAndDelete(req.params.scriptId).lean()
    if (!doc) return res.status(404).json({ error: 'Script not found' })
    // Nothing left to switch off
    await CoachSettings.updateOne({ key: 'default' }, { $pull: { disabledScenarios: doc.key } })
    logActivity({ category: 'portal', action: 'english_coach_script_delete', message: `Deleted English Coach script "${doc.title}"`, req, meta: { key: doc.key, builtIn: doc.builtIn ?? null } })
    res.json(await scriptsView())
  } catch (err) { fail(res, 'delete')(err) }
}

/** A part copied from the book → the book's own title and lines again. */
export async function restoreScript(req, res) {
  try {
    if (!isId(req.params.scriptId)) return res.status(404).json({ error: 'Script not found' })
    const doc = await CoachScript.findById(req.params.scriptId)
    if (!doc) return res.status(404).json({ error: 'Script not found' })
    const unit = doc.builtIn && bookUnit(doc.builtIn)
    if (!unit) return res.status(400).json({ error: 'This script was written in the portal, so there is no book version to go back to.' })
    const { title, plays } = bookPart(unit)
    doc.set({ title, plays, updatedBy: req.userId })
    await doc.save()
    logActivity({ category: 'portal', action: 'english_coach_script_restore', message: `Restored English Coach script "${doc.title}" to the book`, req, meta: { key: doc.key } })
    res.json(await scriptsView())
  } catch (err) { fail(res, 'restore')(err) }
}

/** Put back the book's parts that were deleted, at their place in the book. */
export async function restoreBook(req, res) {
  try {
    await ensureBookScripts()
    const present = new Set((await CoachScript.find({ builtIn: { $exists: true } }).select('builtIn').lean()).map(d => d.builtIn))
    const missing = BOOK_UNITS.filter(u => !present.has(u.unit))
    for (const u of missing) {
      // A deleted part's key is free again — unless a portal part took it, which can't happen (portal keys are script_…)
      await CoachScript.updateOne({ key: bookKey(u.unit) }, { $setOnInsert: { key: bookKey(u.unit), order: u.unit, ...bookPart(u), updatedBy: req.userId } }, { upsert: true })
    }
    if (missing.length) {
      logActivity({ category: 'portal', action: 'english_coach_script_restore', message: `Restored ${missing.length} part(s) of the Role-Play Practice Book`, req, meta: { units: missing.map(u => u.unit) } })
    }
    res.json({ restored: missing.length, ...await scriptsView() })
  } catch (err) { fail(res, 'restore book')(err) }
}

export async function reorderScripts(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null
    if (!ids || !ids.every(isId)) return res.status(400).json({ error: 'Send the scripts in their new order.' })
    const all = await CoachScript.find().select('_id').lean()
    if (ids.length !== all.length || new Set(ids).size !== ids.length || !all.every(d => ids.includes(String(d._id)))) {
      return res.status(409).json({ error: 'The list of scripts has changed. Reload the page and try again.' })
    }
    await CoachScript.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i + 1 } } } })))
    res.json(await scriptsView())
  } catch (err) { fail(res, 'reorder')(err) }
}
