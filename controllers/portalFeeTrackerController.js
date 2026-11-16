// Fee Tracker (/portal/fee-tracker) — the office's monthly fee-chasing list.
// It replaces the client's own "Hidaya Receivables" Google Sheet: one row per
// family (a family sends one payment for all its children), every active or
// on-leave student whose fee is due, with three states the sheet showed by
// colour — not reminded yet (white), link/reminder sent (green), received
// (blue) — plus "ignore this month".
//
// It READS the Fee Management data (StudentFeeRecord, the same base-fee
// auto-billing rule as the Fee Management grid) and never writes it. What the
// office does here lives in FeeTrackerEntry (per row, per month) and
// FeeTrackerReceipt (a payment marked received, which prints a receipt).
// A month a tracker receipt covers counts as settled on the tracker only.
import mongoose from 'mongoose'
import Student from '../models/Student.js'
import Family from '../models/Family.js'
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import FeeTrackerEntry from '../models/FeeTrackerEntry.js'
import FeeTrackerReceipt from '../models/FeeTrackerReceipt.js'
import { logActivity } from '../utils/activityLogger.js'

// The portal's fee records begin in January 2026 (when the fee sheet was
// imported). Months before that were never entered, so counting them would put
// every long-standing student years in arrears.
export const TRACK_FROM = { year: 2026, month: 1 }
// How far back unpaid months are looked for.
export const LOOKBACK_MONTHS = 12

const CURRENCIES = ['PKR', 'USD', 'EUR', 'GBP', 'CAD']
const GROUP_KEY = /^[fs]:[0-9a-f]{24}$/

const toIdx = (y, m) => y * 12 + (m - 1)
const fromIdx = (i) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 })
const isId = (v) => mongoose.isValidObjectId(v) && String(v).length === 24

// "HID12" → 12, so rows sort the way the sheet does (by roll number).
function rollNum(rollNo) {
  const n = parseInt(String(rollNo || '').replace(/\D/g, ''), 10)
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

export function groupKeyOf(student) {
  const fam = student.familyId?._id || student.familyId
  return fam ? `f:${fam}` : `s:${student._id}`
}

// "Today" in Asia/Karachi — the academy's billing clock.
function karachiNow() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).format(new Date())
  return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) }
}

// The tracker month from ?year=&month= (defaults to this month). null = invalid.
function parsePeriod(src = {}) {
  const now = karachiNow()
  const year = src.year == null || src.year === '' ? now.year : parseInt(src.year, 10)
  const month = src.month == null || src.month === '' ? now.month : parseInt(src.month, 10)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  return { year, month }
}

// First month a student can owe. joiningDate is stored as a date-only value
// (UTC midnight), so it is read in UTC — the same rule as the Fee Management grid.
function joinIdx(s) {
  const jd = s.joiningDate || s.createdAt
  const d = jd ? new Date(jd) : null
  if (!d || isNaN(d.getTime())) return -Infinity
  return toIdx(d.getUTCFullYear(), d.getUTCMonth() + 1)
}

/**
 * Per-student fee position for tracker month M, read from Fee Management plus
 * the tracker's own receipts. Each month from max(window start, joining) to M:
 *   - covered by a tracker receipt          → settled ('tracker')
 *   - waived in Fee Management (NSY etc.)   → settled ('waived')
 *   - received in Fee Management            → settled ('paid')
 *   - otherwise the agreed amount (the month's own receivable, else the base
 *     fee) less anything paid                → owed ('owed' / 'partial')
 */
function studentPosition(s, cells, covered, win) {
  const { M, startIdx } = win
  const baseFee = s.billing?.fee || 0
  const owed = []
  let thisMonth = { state: 'none', paid: 0, currency: 'PKR', note: '' }
  for (let i = Math.max(startIdx, joinIdx(s)); i <= M; i++) {
    const cell = cells?.get(i)
    let state
    let due = 0
    if (covered?.has(i)) state = 'tracker'
    else if (cell?.status === 'waived') state = 'waived'
    else if (cell?.status === 'received') state = 'paid'
    else {
      const paid = cell?.amountPaid || 0
      const agreed = cell?.amount > 0 ? cell.amount : baseFee
      due = Math.max(0, agreed - paid)
      state = due > 0 ? (paid > 0 ? 'partial' : 'owed') : (paid > 0 ? 'paid' : 'none')
    }
    if (due > 0) owed.push({ ...fromIdx(i), amount: due, partial: state === 'partial', note: cell?.note || '' })
    if (i === M) {
      thisMonth = { state, paid: cell?.amountPaid || 0, currency: cell?.currency || 'PKR', note: cell?.note || '' }
    }
  }
  return {
    _id: s._id,
    name: s.name,
    rollNo: s.rollNo || '',
    year: yearView(s, cells, covered, win),
    status: s.status,
    joiningDate: s.joiningDate || null,
    baseFee,
    billedAmount: s.billing?.amount || 0,
    billedCurrency: s.billing?.currency || 'PKR',
    mode: s.billing?.paymentMethod || '',
    cycle: s.billing?.cycle || 'monthly', // unset → monthly (the schema default)
    owed,
    owedTotal: owed.reduce((sum, o) => sum + o.amount, 0),
    thisMonth,
  }
}

/**
 * One cell per year-view column, like the client's sheet: a month before the
 * student joined reads NSY; a waived month shows its Fee Management note (DA =
 * didn't attend, NSY = not started yet, DNA, BD…); an unpaid month its amount.
 *   state: nsy | waived | paid | tracker | owed | partial | none | nodata | future
 */
function yearView(s, cells, covered, { M, colStart, colEnd }) {
  const baseFee = s.billing?.fee || 0
  const joined = joinIdx(s)
  const tracked = toIdx(TRACK_FROM.year, TRACK_FROM.month)
  const out = []
  for (let i = colStart; i <= colEnd; i++) {
    const cell = cells?.get(i)
    const note = cell?.note || ''
    let state, amount = 0
    if (covered?.has(i)) state = 'tracker'
    else if (cell?.status === 'waived') state = 'waived'
    else if (cell?.status === 'received') { state = 'paid'; amount = cell.amountPaid || 0 }
    else if (i < joined) state = 'nsy'
    else if (i > M) state = 'future'
    else if (i < tracked && !cell) state = 'nodata' // before the portal's fee records begin
    else {
      const paid = cell?.amountPaid || 0
      const agreed = cell?.amount > 0 ? cell.amount : baseFee
      amount = Math.max(0, agreed - paid)
      state = amount > 0 ? (paid > 0 ? 'partial' : 'owed') : (paid > 0 ? 'paid' : 'none')
      if (state === 'paid') amount = paid
    }
    out.push({ state, amount, note })
  }
  return out
}

// The months the tracker looks at for month M, and the year view's columns:
// the twelve months ending one month after M (January–December for November).
function windowOf(year, month) {
  const M = toIdx(year, month)
  const startIdx = Math.max(toIdx(TRACK_FROM.year, TRACK_FROM.month), M - (LOOKBACK_MONTHS - 1))
  const colStart = M - 10, colEnd = M + 1
  return { M, startIdx, start: fromIdx(startIdx), colStart, colEnd }
}

export function yearColumns(year, month) {
  const { colStart, colEnd } = windowOf(year, month)
  const cols = []
  for (let i = colStart; i <= colEnd; i++) cols.push(fromIdx(i))
  return cols
}

// Fee Management cells and tracker receipts for the window. `ids` null = every
// student (the board), which lets these run alongside the student query
// instead of after it.
function fetchFeeData(year, month, ids) {
  const { start, colStart, colEnd } = windowOf(year, month)
  const scope = ids ? { studentId: { $in: ids } } : {}
  const fromYear = Math.min(start.year, fromIdx(colStart).year)
  return Promise.all([
    StudentFeeRecord.find({ ...scope, year: { $gte: fromYear, $lte: fromIdx(colEnd).year } })
      .select('studentId year month amount amountPaid currency status note').lean(),
    FeeTrackerReceipt.find({
      $or: [
        { year, month },
        { ...(ids ? { 'lines.studentId': { $in: ids } } : {}), 'lines.months.year': { $gte: fromYear } },
      ],
    }).sort({ paidAt: 1, createdAt: 1 }).lean(),
  ]).then(([cells, receipts]) => ({ cells, receipts }))
}

function positionsFrom(students, cells, receipts, year, month) {
  const win = windowOf(year, month)
  const cellMap = new Map()
  for (const c of cells) {
    const k = String(c.studentId)
    if (!cellMap.has(k)) cellMap.set(k, new Map())
    cellMap.get(k).set(toIdx(c.year, c.month), c)
  }
  const coveredMap = new Map()
  for (const r of receipts) {
    for (const line of r.lines || []) {
      const k = String(line.studentId)
      if (!coveredMap.has(k)) coveredMap.set(k, new Set())
      for (const m of line.months || []) coveredMap.get(k).add(toIdx(m.year, m.month))
    }
  }
  const positions = new Map()
  for (const s of students) {
    const k = String(s._id)
    positions.set(k, studentPosition(s, cellMap.get(k), coveredMap.get(k), win))
  }
  return positions
}

// 2CO (2Checkout) is the card-subscription route — those families sit at the bottom.
const is2CO = (mode) => /^\s*2\s*co\b/i.test(String(mode || ''))
function sortGroup(row) {
  if (is2CO(row.mode)) return 2
  return row.members.some(m => m.cycle !== 'monthly') && !row.members.some(m => m.cycle === 'monthly') ? 1 : 0
}

const sumByCurrency = (pairs) => {
  const m = new Map()
  for (const { currency, amount } of pairs) {
    if (!amount) continue
    const c = currency || 'PKR'
    m.set(c, (m.get(c) || 0) + amount)
  }
  return [...m.entries()].map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => (a.currency === 'PKR' ? -1 : b.currency === 'PKR' ? 1 : a.currency.localeCompare(b.currency)))
}

const receiptSummary = (r) => ({
  _id: r._id,
  receiptNo: r.receiptNo,
  amount: r.amount,
  currency: r.currency,
  mode: r.mode,
  paidAt: r.paidAt,
  payerName: r.payerName,
  groupKey: r.groupKey,
  familyCode: r.familyCode,
})

/** The month's board: one row per family (or solo student) with something due or received. */
export async function buildBoard(year, month) {
  const M = toIdx(year, month)
  const { start } = windowOf(year, month)
  // All five reads run side by side rather than one after another.
  const [all, families, { cells, receipts }, entries] = await Promise.all([
    Student.find({ status: { $in: ['active', 'leave', 'pending'] } })
      .select('name rollNo status familyId billing joiningDate createdAt').lean(),
    Family.find().select('familyCode primaryGuardian.name').lean(),
    fetchFeeData(year, month, null),
    FeeTrackerEntry.find({ year, month }).lean(),
  ])
  const familyMap = new Map(families.map(f => [String(f._id), f]))
  const students = all
    // Not on the list before they joined.
    .filter(s => joinIdx(s) <= M)
    .map(s => ({ ...s, familyId: s.familyId ? familyMap.get(String(s.familyId)) || null : null }))
  const positions = positionsFrom(students, cells, receipts, year, month)
  const entryMap = new Map(entries.map(e => [e.groupKey, e]))

  const groups = new Map()
  for (const s of students) {
    const key = groupKeyOf(s)
    if (!groups.has(key)) groups.set(key, { key, family: s.familyId || null, members: [] })
    groups.get(key).members.push(positions.get(String(s._id)))
  }

  const rows = []
  for (const g of groups.values()) {
    g.members.sort((a, b) => rollNum(a.rollNo) - rollNum(b.rollNo) || a.name.localeCompare(b.name))
    const memberIds = new Set(g.members.map(m => String(m._id)))
    const lead = g.members.find(m => m.status === 'active') || g.members[0]
    const entry = entryMap.get(g.key)

    // Receipts that settle this row for the month: the ones marked from it, and
    // anyone else's payment that covered one of its students for this month.
    const rowReceipts = []
    for (const r of receipts) {
      const own = r.groupKey === g.key && r.year === year && r.month === month
      const share = (r.lines || [])
        .filter(l => memberIds.has(String(l.studentId)))
      const coversMonth = share.some(l => (l.months || []).some(x => x.year === year && x.month === month))
      if (!own && !coversMonth) continue
      rowReceipts.push({
        ...receiptSummary(r),
        own,
        // A payment marked from another row shows only this family's part of it.
        amount: own ? r.amount : share.reduce((sum, l) => sum + (l.amount || 0), 0),
      })
    }

    const owedTotal = g.members.reduce((sum, m) => sum + m.owedTotal, 0)
    const portalPaid = sumByCurrency(g.members
      .filter(m => m.thisMonth.state === 'paid' || m.thisMonth.state === 'partial')
      .map(m => ({ currency: m.thisMonth.currency, amount: m.thisMonth.paid })))

    let state
    if (rowReceipts.length) state = 'received'
    else if (owedTotal > 0) state = entry?.linkSent ? 'sent' : 'due'
    else if (portalPaid.length) state = 'received' // recorded in Fee Management
    else continue // nothing due this month

    rows.push({
      key: g.key,
      familyId: g.family?._id || null,
      familyCode: g.family?.familyCode || '',
      guardian: g.family?.primaryGuardian?.name || '',
      lead: { _id: lead._id, name: lead.name, rollNo: lead.rollNo },
      members: g.members,
      joiningDate: lead.joiningDate,
      mode: lead.mode || g.members.find(m => m.mode)?.mode || '',
      monthlyFee: g.members.reduce((sum, m) => sum + m.baseFee, 0),
      allOnLeave: g.members.every(m => m.status === 'leave'),
      anyOnLeave: g.members.some(m => m.status === 'leave'),
      owedTotal,
      // Typed by the office, or null (client, 16 Nov 2026: "expected ko manual kr den").
      // owedTotal is what the portal computes, shown alongside as a hint.
      expected: entry?.expected ?? null,
      linkSent: !!entry?.linkSent,
      linkSentAt: entry?.linkSentAt || null,
      ignored: !!entry?.ignored,
      note: entry?.note || '',
      state,
      receivedFrom: rowReceipts.length ? 'tracker' : state === 'received' ? 'portal' : '',
      receipts: rowReceipts,
      portalPaid,
    })
  }

  // The client's order (16 Nov 2026): families paying monthly first, other
  // billing cycles (quarterly…) next, and everyone paying by 2CO together at
  // the bottom; roll number within each group, like the sheet.
  rows.sort((a, b) => sortGroup(a) - sortGroup(b) || rollNum(a.lead.rollNo) - rollNum(b.lead.rollNo) || a.lead.name.localeCompare(b.lead.name))

  const live = rows.filter(r => !r.ignored)
  const summary = {
    rows: rows.length,
    due: live.filter(r => r.state === 'due').length,
    sent: live.filter(r => r.state === 'sent').length,
    received: live.filter(r => r.state === 'received').length,
    ignored: rows.length - live.length,
    // The office's expected amounts are in the local fee (PKR), like the sheet.
    // Only what the office has typed — the sheet's red "Due" total.
    expected: live.filter(r => r.state === 'due' || r.state === 'sent').reduce((sum, r) => sum + (r.expected || 0), 0),
    expectedTyped: live.filter(r => (r.state === 'due' || r.state === 'sent') && r.expected != null).length,
    owed: live.filter(r => r.state === 'due' || r.state === 'sent').reduce((sum, r) => sum + r.owedTotal, 0),
    // Money marked received on the tracker from this month's rows, per currency.
    receivedAmounts: sumByCurrency(receipts.filter(r => r.year === year && r.month === month)),
    // Money already in Fee Management for this month on rows with no tracker receipt.
    portalAmounts: sumByCurrency(rows.filter(r => r.receivedFrom === 'portal').flatMap(r => r.portalPaid)),
  }

  const modes = [...new Set(students.map(s => (s.billing?.paymentMethod || '').trim()).filter(Boolean))].sort()

  return { year, month, rows, summary, modes, columns: yearColumns(year, month), window: { from: start, to: { year, month } }, trackFrom: TRACK_FROM }
}

// GET /portal/fee-tracker?year=&month=
export async function getBoard(req, res) {
  try {
    const period = parsePeriod(req.query)
    if (!period) return res.status(400).json({ error: 'Pick a valid month' })
    res.json(await buildBoard(period.year, period.month))
  } catch (err) {
    console.error('Fee tracker board error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/fee-tracker/student/:id?year=&month= — one student's unpaid
// months, for "Add another student" in the Mark received window.
export async function getStudentPosition(req, res) {
  try {
    const period = parsePeriod(req.query)
    if (!period) return res.status(400).json({ error: 'Pick a valid month' })
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Student not found' })
    const s = await Student.findById(req.params.id)
      .select('name rollNo status familyId billing joiningDate createdAt')
      .populate('familyId', 'familyCode').lean()
    if (!s) return res.status(404).json({ error: 'Student not found' })
    const { cells, receipts } = await fetchFeeData(period.year, period.month, [s._id])
    const positions = positionsFrom([s], cells, receipts, period.year, period.month)
    res.json({
      member: positions.get(String(s._id)),
      groupKey: groupKeyOf(s),
      familyCode: s.familyId?.familyCode || '',
    })
  } catch (err) {
    console.error('Fee tracker student error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

async function groupExists(groupKey) {
  const id = groupKey.slice(2)
  return groupKey[0] === 'f' ? Family.exists({ _id: id }) : Student.exists({ _id: id })
}

// PATCH /portal/fee-tracker/entry — tick/untick "link sent", ignore/unignore
// for the month, type over (or reset with null) the expected amount, a note.
export async function updateEntry(req, res) {
  try {
    const period = parsePeriod(req.body)
    if (!period) return res.status(400).json({ error: 'Pick a valid month' })
    const { groupKey } = req.body
    if (!GROUP_KEY.test(String(groupKey || ''))) return res.status(400).json({ error: 'Unknown row' })
    if (!(await groupExists(groupKey))) return res.status(404).json({ error: 'That family or student no longer exists' })

    const set = { updatedBy: req.userId }
    const unset = {}
    if (req.body.linkSent !== undefined) {
      set.linkSent = !!req.body.linkSent
      if (set.linkSent) set.linkSentAt = new Date()
      else unset.linkSentAt = 1
    }
    if (req.body.ignored !== undefined) set.ignored = !!req.body.ignored
    if (req.body.expected !== undefined) {
      if (req.body.expected === null || req.body.expected === '') set.expected = null
      else {
        const n = Number(req.body.expected)
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Expected amount must be 0 or more' })
        set.expected = Math.round(n)
      }
    }
    if (req.body.note !== undefined) set.note = String(req.body.note || '').trim().slice(0, 500)

    const fam = groupKey[0] === 'f' ? { familyId: groupKey.slice(2) } : { studentId: groupKey.slice(2) }
    const entry = await FeeTrackerEntry.findOneAndUpdate(
      { year: period.year, month: period.month, groupKey },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $setOnInsert: fam },
      { upsert: true, new: true, runValidators: true },
    ).lean()
    res.json(entry)
  } catch (err) {
    console.error('Fee tracker entry error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// FT-2026-0001, numbered per year. A clash (two saves at once) retries.
async function nextReceiptNo(year) {
  const prefix = `FT-${year}-`
  const last = await FeeTrackerReceipt.findOne({ receiptNo: { $regex: `^${prefix}\\d+$` } })
    .sort({ receiptNo: -1 }).select('receiptNo').lean()
  const n = last ? parseInt(last.receiptNo.slice(prefix.length), 10) + 1 : 1
  return `${prefix}${String(n).padStart(4, '0')}`
}

// POST /portal/fee-tracker/receipts — mark a payment received. One payment can
// cover several students (the family's, plus anyone else's sent along with it)
// and several months each.
export async function createReceipt(req, res) {
  try {
    const period = parsePeriod(req.body)
    if (!period) return res.status(400).json({ error: 'Pick a valid month' })
    const { groupKey } = req.body
    if (!GROUP_KEY.test(String(groupKey || ''))) return res.status(400).json({ error: 'Unknown row' })

    const rawLines = Array.isArray(req.body.lines) ? req.body.lines : []
    if (!rawLines.length) return res.status(400).json({ error: 'Tick at least one student' })
    if (rawLines.length > 40) return res.status(400).json({ error: 'Too many students on one payment' })

    const seen = new Set()
    const lines = []
    for (const l of rawLines) {
      const sid = String(l?.studentId || '')
      if (!isId(sid)) return res.status(400).json({ error: 'Unknown student on the payment' })
      if (seen.has(sid)) return res.status(400).json({ error: 'A student is on the payment twice' })
      seen.add(sid)
      const monthKeys = new Set()
      const months = []
      for (const m of Array.isArray(l.months) ? l.months : []) {
        const y = parseInt(m?.year, 10), mo = parseInt(m?.month, 10)
        if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(mo) || mo < 1 || mo > 12) {
          return res.status(400).json({ error: 'A month on the payment is not valid' })
        }
        const k = toIdx(y, mo)
        if (monthKeys.has(k)) continue
        monthKeys.add(k)
        months.push({ year: y, month: mo })
      }
      if (!months.length) return res.status(400).json({ error: 'Pick at least one month for each student' })
      if (months.length > 36) return res.status(400).json({ error: 'Too many months for one student' })
      months.sort((a, b) => toIdx(a.year, a.month) - toIdx(b.year, b.month))
      const amount = Number(l.amount)
      if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Amounts must be 0 or more' })
      lines.push({ studentId: sid, months, amount: Math.round(amount * 100) / 100 })
    }

    const students = await Student.find({ _id: { $in: lines.map(l => l.studentId) } }).select('name rollNo').lean()
    const byId = new Map(students.map(s => [String(s._id), s]))
    for (const l of lines) {
      const s = byId.get(l.studentId)
      if (!s) return res.status(404).json({ error: 'A student on the payment no longer exists' })
      l.name = s.name
      l.rollNo = s.rollNo || ''
    }

    const linesTotal = lines.reduce((sum, l) => sum + l.amount, 0)
    const amount = req.body.amount === undefined || req.body.amount === null || req.body.amount === ''
      ? linesTotal : Number(req.body.amount)
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter the amount received' })

    const currency = CURRENCIES.includes(req.body.currency) ? req.body.currency : 'PKR'
    let paidAt = req.body.paidAt ? new Date(req.body.paidAt) : new Date()
    if (isNaN(paidAt.getTime())) paidAt = new Date()

    let familyId, familyCode = ''
    if (groupKey[0] === 'f') {
      const fam = await Family.findById(groupKey.slice(2)).select('familyCode').lean()
      if (!fam) return res.status(404).json({ error: 'That family no longer exists' })
      familyId = fam._id
      familyCode = fam.familyCode || ''
    } else if (!(await Student.exists({ _id: groupKey.slice(2) }))) {
      return res.status(404).json({ error: 'That student no longer exists' })
    }

    const doc = {
      year: period.year,
      month: period.month,
      groupKey,
      familyId,
      familyCode,
      amount: Math.round(amount * 100) / 100,
      currency,
      mode: String(req.body.mode || '').trim().slice(0, 60),
      paidAt,
      payerName: String(req.body.payerName || '').trim().slice(0, 120),
      reference: String(req.body.reference || '').trim().slice(0, 120),
      note: String(req.body.note || '').trim().slice(0, 500),
      lines,
      recordedBy: req.userId,
    }

    let receipt
    for (let attempt = 0; attempt < 5 && !receipt; attempt++) {
      try {
        receipt = await FeeTrackerReceipt.create({ ...doc, receiptNo: await nextReceiptNo(period.year) })
      } catch (err) {
        if (err?.code !== 11000) throw err
      }
    }
    if (!receipt) return res.status(409).json({ error: 'Could not number the receipt — please try again' })

    await logActivity({
      level: 'info', category: 'finance', action: 'fee_tracker_received',
      message: `Fee Tracker: ${receipt.receiptNo} — ${currency} ${receipt.amount} for ${lines.length} student(s)`,
      req, meta: { receiptId: receipt._id, groupKey },
    })
    res.status(201).json(receipt.toObject())
  } catch (err) {
    console.error('Fee tracker receipt error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/fee-tracker/receipts?year=&month=[&groupKey=] — the payments
// marked received from that month's rows, newest first.
export async function listReceipts(req, res) {
  try {
    const period = parsePeriod(req.query)
    if (!period) return res.status(400).json({ error: 'Pick a valid month' })
    const filter = { year: period.year, month: period.month }
    if (req.query.groupKey) {
      if (!GROUP_KEY.test(String(req.query.groupKey))) return res.status(400).json({ error: 'Unknown row' })
      filter.groupKey = req.query.groupKey
    }
    const records = await FeeTrackerReceipt.find(filter)
      .populate('recordedBy', 'displayName')
      .sort({ paidAt: -1, createdAt: -1 })
      .lean()
    res.json({ records })
  } catch (err) {
    console.error('Fee tracker receipts error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/fee-tracker/receipts/:id — one receipt (to reprint it).
export async function getReceipt(req, res) {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Receipt not found' })
    const r = await FeeTrackerReceipt.findById(req.params.id).populate('recordedBy', 'displayName').lean()
    if (!r) return res.status(404).json({ error: 'Receipt not found' })
    res.json(r)
  } catch (err) {
    console.error('Fee tracker receipt read error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// DELETE /portal/fee-tracker/receipts/:id — undo a payment marked by mistake.
// The months it covered go back to unpaid on the tracker.
export async function deleteReceipt(req, res) {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Receipt not found' })
    const r = await FeeTrackerReceipt.findByIdAndDelete(req.params.id).lean()
    if (!r) return res.status(404).json({ error: 'Receipt not found' })
    await logActivity({
      level: 'warning', category: 'finance', action: 'fee_tracker_receipt_deleted',
      message: `Fee Tracker: ${r.receiptNo} removed (${r.currency} ${r.amount})`,
      req, meta: { receiptId: r._id, groupKey: r.groupKey },
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('Fee tracker receipt delete error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}
