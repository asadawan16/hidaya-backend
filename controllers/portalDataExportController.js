// Portal "Data Export" — the disaster-recovery backup. Streams every portal
// collection as CSV into one ZIP (see config/dataExport.js for what is in it and
// what is deliberately left out). Super-admin only by default (`data.export`).
//
// Memory: nothing is loaded whole. Each CSV is an async generator over a Mongo
// cursor, and collections are added to the ZIP one after another, so the export
// holds roughly one batch of documents at a time — it has to fit a small Render box.
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { once } from 'events'
import { createRequire } from 'module'
import { Readable } from 'stream'
import { finished } from 'stream/promises'
import DataExport from '../models/DataExport.js'
import { EXPORT_COLLECTIONS, EXCLUDED, EXPORT_REMINDER_DAYS } from '../config/dataExport.js'
import { emitToUser } from '../config/socket.js'
import { logActivity } from '../utils/activityLogger.js'

const require = createRequire(import.meta.url)
const { ZipArchive } = require('archiver')

const DAY_MS = 24 * 60 * 60 * 1000
const BATCH = 500
const BOM = String.fromCharCode(0xFEFF) // Excel needs it to read Urdu/Arabic names as UTF-8

// ─── CSV helpers ───

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && !(v instanceof Date) && !v._bsontype && !Buffer.isBuffer(v)
}

function cellText(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  if (v._bsontype) return v.toString() // ObjectId, Decimal128
  if (Buffer.isBuffer(v)) return v.toString('base64')
  if (typeof v === 'object') return JSON.stringify(v) // arrays + empty objects
  return String(v)
}

const omitted = (path, omit) => omit.some(o => path === o || path.startsWith(`${o}.`))

/** Nested objects become dotted columns (mfa.enabled); arrays stay one JSON cell. */
export function flattenDoc(doc, omit = [], prefix = '', out = {}) {
  for (const [k, v] of Object.entries(doc)) {
    if (k === '__v') continue
    const path = prefix ? `${prefix}.${k}` : k
    if (omitted(path, omit)) continue
    if (isPlainObject(v) && Object.keys(v).length) flattenDoc(v, omit, path, out)
    else out[path] = cellText(v)
  }
  return out
}

export function csvEscape(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Schema-declared columns, so an empty or sparse collection still shows its shape.
function schemaColumns(model, omit) {
  const cols = []
  model.schema.eachPath((path, type) => {
    if (path === '__v' || omitted(path, omit)) return
    if (type.instance === 'Mixed' || type.$isSingleNested) return // these flatten into sub-columns
    cols.push(path)
  })
  return cols
}

function orderColumns(set) {
  const tail = ['createdAt', 'updatedAt'].filter(c => set.has(c))
  return ['_id', ...[...set].filter(c => c !== '_id' && !tail.includes(c)), ...tail]
}

const cursorOf = (model) => model.find().sort({ _id: 1 }).lean().cursor({ batchSize: BATCH })

/**
 * One collection as CSV, reading the database ONCE. The header must list every
 * column any document uses (fields added to a schema later, legacy fields
 * removed from it), which isn't known until the last document — so rows are
 * staged as JSON lines in a temp file while the columns are collected, then
 * replayed as CSV. Reading Mongo twice instead doubled the export time.
 * `onDone(count)` fires after the last row.
 */
async function* collectionCsv(spec, onDone) {
  const omit = spec.omit || []
  const columns = new Set(['_id', ...schemaColumns(spec.model, omit)])
  const tmp = path.join(os.tmpdir(), `myfuturecampus-export-${process.pid}-${Date.now()}-${spec.file}.jsonl`)
  const stage = fs.createWriteStream(tmp)
  let count = 0
  try {
    for await (const doc of cursorOf(spec.model)) {
      const row = flattenDoc(doc, omit)
      for (const k of Object.keys(row)) columns.add(k)
      if (!stage.write(JSON.stringify(row) + '\n')) await once(stage, 'drain')
      count++
    }
    stage.end()
    await finished(stage)

    const cols = orderColumns(columns)
    yield Buffer.from(BOM + cols.map(csvEscape).join(',') + '\r\n')

    let lines = []
    const replay = readline.createInterface({ input: fs.createReadStream(tmp), crlfDelay: Infinity })
    for await (const line of replay) {
      if (!line) continue
      const row = JSON.parse(line)
      lines.push(cols.map(c => csvEscape(row[c] ?? '')).join(','))
      if (lines.length >= BATCH) {
        yield Buffer.from(lines.join('\r\n') + '\r\n')
        lines = []
      }
    }
    if (lines.length) yield Buffer.from(lines.join('\r\n') + '\r\n')
    onDone(count)
  } finally {
    stage.destroy()
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
  }
}

const csvPath = (spec) => `${spec.folder}/${spec.file}.csv`

function readme({ exportedAt, by, rows }) {
  const total = rows.reduce((s, r) => s + r.count, 0)
  return [
    'MY FUTURE CAMPUS PORTAL — DATA EXPORT (disaster-recovery backup)',
    '======================================================',
    '',
    `Exported:     ${exportedAt.toISOString()}`,
    `Exported by:  ${by}`,
    `Files:        ${rows.length} CSV files, ${total.toLocaleString('en-US')} records`,
    '',
    'FORMAT',
    '- One CSV per database collection, UTF-8 with BOM (opens correctly in Excel).',
    '- _id is the record\'s database id. Columns holding another record\'s id',
    '  (studentId, tutorId, userId, …) refer to the _id in that record\'s file.',
    '- Dates are ISO-8601 in UTC (2026-10-15T14:30:00.000Z).',
    '- Nested fields are dotted columns (guardian.phone). Lists are one JSON cell.',
    '- Passwords, MFA secrets, reset codes and device push tokens are NOT included.',
    '  After a restore, users reset their password and re-enrol MFA.',
    '',
    'FILES  (records · file · contents)',
    ...rows.map(r => `  ${String(r.count).padStart(8)}  ${r.path.padEnd(44)} ${r.label}`),
    '',
    'NOT INCLUDED (on purpose)',
    ...EXCLUDED.map(e => `  - ${e.model}: ${e.reason}`),
    '',
    'manifest.csv lists the same files and counts in machine-readable form.',
    '',
  ].join('\r\n')
}

// ─── Handlers ───

let running = false

// GET /portal/data-export/download — the ZIP itself.
export async function downloadExport(req, res) {
  if (running) return res.status(409).json({ error: 'An export is already running — try again in a minute.' })
  running = true
  const started = Date.now()
  const exportedAt = new Date()
  const stamp = exportedAt.toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
  const fileName = `myfuturecampus-portal-backup-${stamp}.zip`
  const total = EXPORT_COLLECTIONS.length
  const rows = []
  let aborted = false

  const archive = new ZipArchive({ zlib: { level: 6 } })
  const release = () => { running = false }

  res.on('close', () => {
    if (!res.writableFinished) { aborted = true; archive.abort() }
    release()
  })
  res.on('finish', async () => {
    release()
    if (aborted) return
    const totalRecords = rows.reduce((s, r) => s + r.count, 0)
    try {
      await DataExport.create({
        exportedBy: req.userId, fileName, totalRecords, fileCount: rows.length,
        bytes: archive.pointer(), durationMs: Date.now() - started,
      })
      await logActivity({
        level: 'info', category: 'system', action: 'data_export',
        message: `Portal data export: ${rows.length} files, ${totalRecords} records`, req,
      })
    } catch (e) { console.error('Record data export failed:', e.message) }
  })

  // Always listening: an unhandled 'error' event would take the whole server down.
  archive.on('error', (err) => {
    if (!aborted) console.error('Data export archive error:', err)
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' })
    else res.destroy()
  })

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
  archive.pipe(res)

  // One entry at a time. archiver starts reading a stream the moment it is
  // appended, so appending all 48 up front would open 48 cursors at once — and
  // the manifest would be written before any count was known.
  const by = req.user?.displayName || req.user?.email || String(req.userId)
  try {
    for (const spec of EXPORT_COLLECTIONS) {
      if (aborted) return
      let count = 0
      await appendAndWait(archive, Readable.from(collectionCsv(spec, (n) => { count = n }), { objectMode: false }),
        { name: csvPath(spec), date: exportedAt }, () => aborted)
      if (aborted) return
      rows.push({ path: csvPath(spec), label: spec.label, count })
      emitToUser(req.userId, 'data_export_progress', { done: rows.length, total, label: spec.label, count })
    }
    const manifest = ['file,contents,records', ...rows.map(r => [r.path, r.label, r.count].map(v => csvEscape(String(v))).join(','))]
    archive.append(Buffer.from(BOM + manifest.join('\r\n') + '\r\n'), { name: 'manifest.csv', date: exportedAt })
    archive.append(Buffer.from(readme({ exportedAt, by, rows })), { name: 'README.txt', date: exportedAt })
    await archive.finalize()
  } catch (err) {
    if (aborted) return
    console.error('Data export failed:', err)
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' })
    else res.destroy(err)
  }
}

// Resolves once archiver has written this entry (its 'entry' event), rejects on
// an archive error, and gives up quietly if the download was cancelled.
function appendAndWait(archive, source, data, isAborted) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { archive.off('entry', onEntry); archive.off('error', onError); clearInterval(poll) }
    const onEntry = () => { cleanup(); resolve() }
    const onError = (err) => { cleanup(); reject(err) }
    const poll = setInterval(() => { if (isAborted()) { cleanup(); resolve() } }, 500)
    archive.on('entry', onEntry)
    archive.on('error', onError)
    archive.append(source, data)
  })
}

// GET /portal/data-export/status — the Data Export page.
export async function getExportStatus(req, res) {
  try {
    const [recent, counts] = await Promise.all([
      DataExport.find().sort({ createdAt: -1 }).limit(10).populate('exportedBy', 'displayName email').lean(),
      Promise.all(EXPORT_COLLECTIONS.map(s => s.model.estimatedDocumentCount().catch(() => 0))),
    ])
    const collections = EXPORT_COLLECTIONS.map((s, i) => ({ folder: s.folder, file: `${s.file}.csv`, label: s.label, count: counts[i] }))
    res.json({
      lastExport: recent[0] || null,
      recent,
      reminderDays: EXPORT_REMINDER_DAYS,
      collections,
      totalRecords: counts.reduce((a, b) => a + b, 0),
      excluded: EXCLUDED,
    })
  } catch (err) {
    console.error('Data export status error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/data-export/reminder — cheap check for the weekly popup.
export async function getExportReminder(req, res) {
  try {
    const last = await DataExport.findOne().sort({ createdAt: -1 }).select('createdAt').lean()
    const lastExportAt = last?.createdAt || null
    const daysSince = lastExportAt ? Math.floor((Date.now() - new Date(lastExportAt).getTime()) / DAY_MS) : null
    res.json({ lastExportAt, daysSince, reminderDays: EXPORT_REMINDER_DAYS, due: daysSince === null || daysSince >= EXPORT_REMINDER_DAYS })
  } catch (err) {
    console.error('Data export reminder error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
