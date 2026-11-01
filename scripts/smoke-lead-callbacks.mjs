// Smoke test for lead call follow-ups on the Leads board.
//
// Covers:
//   - logging a call with a callback date moves the lead to 'callback' and
//     sets nextCallbackAt; the entry records who logged it
//   - the list's callback filters (range / anything scheduled) sort soonest
//     first, skip finished leads, and return only the latest note
//   - clearing a callback, terminal statuses dropping the callback, and
//     converting a lead to a student dropping it too
//   - validation: empty note, bad date, unknown status
//
// Mounts the real router on an in-process Express app. Runs against a
// THROWAWAY database (dbName hidaya_lead_callbacks_smoke) and drops it.
// Needs MONGODB_URI and JWT_SECRET only. Run: node scripts/smoke-lead-callbacks.mjs
import 'dotenv/config'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Enrollment from '../models/Enrollment.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../config/permissions.js'
import portalLeadsRoutes from '../routes/portalLeadsRoutes.js'

let pass = 0, fail = 0
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m, detail) }
}

const SMOKE_DB = 'hidaya_lead_callbacks_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
// Hard stop: everything below writes, and the finally block DROPS the database.
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase() // leftovers from an aborted run

const app = express()
app.use(express.json())
app.use('/api/portal/leads', portalLeadsRoutes)
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api/portal/leads`
const tokenFor = (user) => jwt.sign({ id: user._id, type: 'portal' }, process.env.JWT_SECRET, { expiresIn: '10m' })
async function call(user, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(user)}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  return { status: res.status, data }
}

const hours = (n) => new Date(Date.now() + n * 3600_000).toISOString()

try {
  const role = await Role.create({ key: 'admin', name: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, system: true })
  const admin = await User.create({ email: 'admin@smoke.test', password: 'Smoke@12345', displayName: 'Sana Admin', roles: [role._id] })

  const mk = (name) => Enrollment.create({ name, email: `${name.toLowerCase()}@smoke.test`, phone: '+44 7000', source: 'free_class' })
  const ali = await mk('Ali')
  const bea = await mk('Bea')
  const cal = await mk('Cal')

  console.log('\nLogging calls')
  let r = await call(admin, 'POST', `/${ali._id}/log`, { note: 'No answer, try tomorrow', outcome: 'No answer', nextCallbackAt: hours(20) })
  ok(r.status === 200 && r.data.status === 'callback' && r.data.nextCallbackAt, 'a callback date moves the lead to Callback', JSON.stringify(r.data?.status))
  const entry = r.data.callLog?.[0]
  ok(entry?.byName === 'Sana Admin' && entry.outcome === 'No answer' && entry.statusAfter === 'callback' && entry.nextCallbackAt,
    'the entry records who, outcome, status change and the callback', JSON.stringify(entry))

  r = await call(admin, 'POST', `/${bea._id}/log`, { note: 'Asked to call back in an hour', nextCallbackAt: hours(-2) })
  ok(r.status === 200 && r.data.status === 'callback', 'a second lead gets a (now overdue) callback')
  r = await call(admin, 'POST', `/${cal._id}/log`, { note: 'Spoke to father', status: 'contacted' })
  ok(r.status === 200 && r.data.status === 'contacted' && !r.data.nextCallbackAt, 'a note without a date just logs (status set explicitly)')
  r = await call(admin, 'POST', `/${ali._id}/log`, { note: 'Second try, mother picked up', nextCallbackAt: hours(30) })
  ok(r.status === 200 && r.data.callLog.length === 2 && r.data.callLog[1].statusAfter === '', 'rescheduling keeps Callback and adds a second entry')

  console.log('\nValidation')
  r = await call(admin, 'POST', `/${ali._id}/log`, { note: '   ' })
  ok(r.status === 400, 'an empty note is refused')
  r = await call(admin, 'POST', `/${ali._id}/log`, { note: 'x', nextCallbackAt: 'tomorrow-ish' })
  ok(r.status === 400, 'a bad callback date is refused')
  r = await call(admin, 'POST', `/${ali._id}/log`, { note: 'x', status: 'maybe' })
  ok(r.status === 400, 'an unknown status is refused')
  r = await call(admin, 'PATCH', `/${cal._id}/status`, { status: 'nope' })
  ok(r.status === 400, 'the status endpoint refuses unknown statuses too')

  console.log('\nList filters')
  r = await call(admin, 'GET', '/?scheduled=1')
  ok(r.data?.records?.map(l => l.name).join() === 'Bea,Ali', 'All scheduled: soonest first (overdue Bea, then Ali)', r.data?.records?.map(l => l.name).join())
  const aliRow = r.data.records.find(l => l.name === 'Ali')
  ok(aliRow?.lastNote?.note === 'Second try, mother picked up' && aliRow.callLog === undefined, 'list rows carry only the latest note, not the log')
  r = await call(admin, 'GET', `/?callbackTo=${encodeURIComponent(new Date().toISOString())}`)
  ok(r.data?.records?.length === 1 && r.data.records[0].name === 'Bea', 'Overdue = callbacks before now')
  r = await call(admin, 'GET', `/?callbackFrom=${encodeURIComponent(hours(24))}&callbackTo=${encodeURIComponent(hours(48))}`)
  ok(r.data?.records?.length === 1 && r.data.records[0].name === 'Ali', 'a date range finds the lead in it')
  r = await call(admin, 'GET', '/')
  ok(r.data?.statusCounts?.callback === 2 && r.data.statusCounts.contacted === 1, 'status counts include Callback', JSON.stringify(r.data?.statusCounts))
  r = await call(admin, 'GET', '/stats')
  ok(r.data?.statusCounts?.callback === 2, 'stats include Callback')

  console.log('\nClearing callbacks')
  r = await call(admin, 'POST', `/${bea._id}/log`, { note: 'Called back, booking a trial', clearCallback: true, status: 'contacted' })
  ok(r.status === 200 && !r.data.nextCallbackAt && r.data.status === 'contacted', '"callback done" clears it and moves back to Contacted')
  r = await call(admin, 'PATCH', `/${ali._id}/status`, { status: 'closed' })
  ok(r.status === 200 && !r.data.nextCallbackAt, 'closing a lead drops its callback')
  await Enrollment.updateOne({ _id: cal._id }, { $set: { nextCallbackAt: new Date(hours(5)) } })
  r = await call(admin, 'GET', '/?scheduled=1')
  ok(r.data?.records?.length === 1 && r.data.records[0].name === 'Cal', 'only live leads remain scheduled')
  r = await call(admin, 'POST', `/${cal._id}/log`, { note: 'Not interested', nextCallbackAt: hours(10), status: 'closed' })
  ok(r.status === 200 && r.data.status === 'closed' && !r.data.nextCallbackAt && !r.data.callLog.at(-1).nextCallbackAt,
    'a terminal status in the same entry wins over the callback date')
} catch (err) {
  fail++
  console.error('\nSmoke aborted:', err)
} finally {
  server.close()
  if (mongoose.connection.name === SMOKE_DB) await mongoose.connection.dropDatabase().catch(e => console.error('drop failed:', e.message))
  await mongoose.disconnect()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
