// Smoke test for the portal bulk Data Export (disaster-recovery backup):
// /api/portal/data-export/{status,reminder,download}
//
//   - every model in models/ is either exported or deliberately excluded
//   - super admin only by default; admin/tutor get 403
//   - reminder is "due" before the first export and not due right after one
//   - the ZIP holds one CSV per collection + manifest.csv + README.txt
//   - CSV fidelity: header union, dotted nested columns, JSON arrays, quoting,
//     Urdu text, ISO dates — and NO password hashes / MFA secrets / reset codes
//   - legacy admin-portal data (Admin, BlogPost, Subscriber) is not in the ZIP
//   - each completed download is recorded (drives the reminder + history)
//
// Runs against a THROWAWAY database (dbName hidaya_data_export_smoke) on the
// same cluster and drops it at the end. No running server needed.
// Needs MONGODB_URI and JWT_SECRET only. Run: node scripts/smoke-data-export.mjs
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Student from '../models/Student.js'
import SalaryRecord from '../models/SalaryRecord.js'
import BlogPost from '../models/BlogPost.js'
import DataExport from '../models/DataExport.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../config/permissions.js'
import { EXPORT_COLLECTIONS, EXCLUDED } from '../config/dataExport.js'
import portalDataExportRoutes from '../routes/portalDataExportRoutes.js'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx') // its bundled CFB reader opens ZIPs

let pass = 0, fail = 0
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m, detail) }
}

const SMOKE_DB = 'hidaya_data_export_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase()

const app = express()
app.use(express.json())
app.use('/api/portal/data-export', portalDataExportRoutes)
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api/portal/data-export`

const tokenFor = (user) => jwt.sign({ id: user._id, type: 'portal' }, process.env.JWT_SECRET, { expiresIn: '10m' })
const get = (user, p) => fetch(base + p, { headers: { Authorization: `Bearer ${tokenFor(user)}` } })

// Minimal RFC 4180 parser — enough to check what the export wrote.
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') q = false; else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const [head, ...body] = rows
  return { head, rows: body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]]))) }
}

try {
  console.log('\nCoverage')
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models')
  const models = fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''))
  const covered = new Set([...EXPORT_COLLECTIONS.map(s => s.model.modelName), ...EXCLUDED.map(e => e.model)])
  const missing = models.filter(m => !covered.has(m))
  ok(missing.length === 0, 'every model is exported or explicitly excluded', missing.join(', '))
  ok(!EXPORT_COLLECTIONS.some(s => ['Admin', 'BlogPost', 'Subscriber'].includes(s.model.modelName)), 'no legacy admin-portal collections in the export')

  const roles = {}
  for (const key of ['super_admin', 'admin', 'tutor']) {
    roles[key] = await Role.create({ key, name: key, permissions: DEFAULT_ROLE_PERMISSIONS[key], system: true })
  }
  const boss = await User.create({
    email: 'boss@smoke.test', password: 'Smoke@12345', displayName: 'Boss Owner', roles: [roles.super_admin._id],
    mfa: { enabled: true, secretEnc: 'SECRET-SHOULD-NOT-LEAK' }, passwordReset: { otpHash: 'OTP-SHOULD-NOT-LEAK' },
    pushTokens: [{ token: 'ExpoPushToken[SHOULD-NOT-LEAK]' }],
  })
  const admin = await User.create({ email: 'admin@smoke.test', password: 'Smoke@12345', displayName: 'Zed Admin', roles: [roles.admin._id] })
  const tutor = await User.create({ email: 'tutor@smoke.test', password: 'Smoke@12345', displayName: 'Tariq Tutor', roles: [roles.tutor._id] })
  await Student.collection.insertMany([
    { name: 'عائشہ خان', rollNo: 'HID1', guardian: { name: 'Khan, "Senior"', phone: '+92 300 1234567' }, tags: ['a', 'b'], createdAt: new Date('2026-01-02T03:04:05Z') },
    { name: 'Second\nLine', rollNo: 'HID2', legacyOnlyField: 'kept' },
  ])
  await SalaryRecord.create({ subjectType: 'staff', userId: admin._id, month: 9, year: 2026, baseAmount: 50000, netPayable: 49000, fine: 1000, deductions: [{ reason: 'late', amount: 1000 }] })
  await BlogPost.collection.insertOne({ title: 'legacy blog' })

  console.log('\nAccess')
  ok((await get(admin, '/status')).status === 403, 'admin is refused (super admin only by default)')
  ok((await get(tutor, '/download')).status === 403, 'tutor is refused')

  console.log('\nReminder')
  let r = await (await get(boss, '/reminder')).json()
  ok(r.due === true && r.lastExportAt === null, 'due before the first export', JSON.stringify(r))

  r = await (await get(boss, '/status')).json()
  ok(r.collections?.length === EXPORT_COLLECTIONS.length && r.lastExport === null, 'status lists every file, no export yet')
  ok(r.collections.find(c => c.file === 'students.csv')?.count === 2, 'status shows record counts')

  console.log('\nDownload')
  const res = await get(boss, '/download')
  ok(res.status === 200 && res.headers.get('content-type') === 'application/zip', 'streams a ZIP')
  ok(/hidaya-portal-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.zip/.test(res.headers.get('content-disposition') || ''), 'dated file name', res.headers.get('content-disposition'))
  const zip = XLSX.CFB.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' })
  // CFB roots every entry at "Root Entry/"
  const read = (name) => {
    const i = zip.FullPaths.indexOf(`Root Entry/${name}`)
    return i < 0 ? null : Buffer.from(zip.FileIndex[i].content).toString('utf8')
  }
  const csvFiles = zip.FullPaths.filter(p => p.endsWith('.csv') && !p.endsWith('manifest.csv'))
  ok(csvFiles.length === EXPORT_COLLECTIONS.length, `one CSV per collection (${csvFiles.length})`)
  ok(read('README.txt')?.includes('NOT INCLUDED') && read('manifest.csv') !== null, 'README.txt + manifest.csv present')
  ok(!zip.FullPaths.some(p => /blog|subscriber|admins?\.csv/i.test(p)), 'no blog/subscriber/admin files')

  const studentsText = read('people/students.csv')
  ok(studentsText?.charCodeAt(0) === 0xFEFF, 'UTF-8 BOM for Excel')
  const students = parseCsv(studentsText.slice(1))
  const aisha = students.rows.find(s => s.rollNo === 'HID1')
  ok(aisha?.name === 'عائشہ خان', 'Urdu text survives')
  ok(aisha?.['guardian.name'] === 'Khan, "Senior"' && aisha?.['guardian.phone'] === '+92 300 1234567', 'nested fields → dotted columns, commas/quotes escaped')
  ok(aisha?.tags === '["a","b"]', 'arrays → one JSON cell')
  ok(aisha?.createdAt === '2026-01-02T03:04:05.000Z', 'dates are ISO UTC')
  ok(students.rows.find(s => s.rollNo === 'HID2')?.name === 'Second\nLine', 'embedded newline survives quoting')
  ok(students.head.includes('legacyOnlyField') && students.head[0] === '_id', 'header = union of all fields, _id first')

  const usersText = read('people/users.csv')
  const users = parseCsv(usersText.slice(1))
  ok(users.rows.length === 3, 'all users exported')
  ok(!/SHOULD-NOT-LEAK|\$2[aby]\$/.test(usersText), 'no password hashes, MFA secrets, reset codes or push tokens')
  ok(!users.head.some(h => /^password|secretEnc|pushTokens/.test(h)) && users.head.includes('mfa.enabled'), 'credential columns dropped, harmless ones kept')

  const salary = parseCsv(read('finance/salary-records.csv').slice(1)).rows[0]
  ok(salary?.userId === String(admin._id) && salary?.netPayable === '49000', 'ids as hex, numbers as written')
  const manifest = parseCsv(read('manifest.csv').slice(1)).rows
  ok(manifest.find(m => m.file === 'people/students.csv')?.records === '2', 'manifest counts')

  await new Promise(r2 => setTimeout(r2, 300)) // the record is written on 'finish'
  console.log('\nAfter export')
  r = await (await get(boss, '/reminder')).json()
  ok(r.due === false && r.daysSince === 0, 'reminder not due right after an export', JSON.stringify(r))
  const rec = await DataExport.findOne().lean()
  ok(rec && String(rec.exportedBy) === String(boss._id) && rec.fileCount === EXPORT_COLLECTIONS.length && rec.bytes > 0, 'export recorded (who, files, size)', JSON.stringify(rec))
  r = await (await get(boss, '/status')).json()
  ok(r.recent?.length === 1 && r.lastExport?.exportedBy?.displayName === 'Boss Owner', 'history shows who exported')

  await DataExport.collection.updateOne({ _id: rec._id }, { $set: { createdAt: new Date(Date.now() - 8 * 86400000) } }) // raw: mongoose guards createdAt
  r = await (await get(boss, '/reminder')).json()
  ok(r.due === true && r.daysSince === 8, 'due again after a week', JSON.stringify(r))
} catch (err) {
  fail++
  console.error('Smoke crashed:', err)
} finally {
  server.close()
  if (mongoose.connection.name === SMOKE_DB) await mongoose.connection.dropDatabase().catch(e => console.error('drop failed:', e.message))
  await mongoose.disconnect()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
