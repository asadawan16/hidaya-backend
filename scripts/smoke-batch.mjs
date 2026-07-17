// Smoke test for the end-user feedback batch. Runs against the live dev server.
import 'dotenv/config'

const BASE = `http://localhost:${process.env.PORT || 5001}/api`
const email = process.env.ADMIN_EMAIL || 'admin@hidaya.online'
const password = process.env.ADMIN_PASSWORD
let token = ''

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* no body */ }
  return { status: res.status, data }
}

const ok = (label, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`)

const now = new Date()
const month = now.getMonth() + 1, year = now.getFullYear()
const today = now.toISOString().slice(0, 10)

// 1) Login
{
  const r = await call('POST', '/portal/auth/login', { email, password })
  token = r.data?.token
  ok('login as super admin', r.status === 200 && !!token, `status ${r.status}`)
  if (!token) process.exit(1)
}

// 2) Create a management (coordinator) staff user
let staffUserId = ''
{
  const stamp = Date.now()
  const r = await call('POST', '/portal/users', {
    displayName: 'Smoke Coordinator', email: `smoke.coord.${stamp}@hidaya.test`,
    password: 'Passw0rd!23', roleKeys: ['coordinator'],
  })
  staffUserId = r.data?._id || r.data?.user?._id
  ok('create staff (coordinator) user', !!staffUserId, `status ${r.status}`)
}

// 3) Staff attendance — mark absent (item 3)
{
  const r = await call('POST', '/portal/attendance/mark-absent', { userId: staffUserId, date: today })
  ok('staff attendance mark-absent', r.status === 200 && r.data?.subjectType === 'staff', `status ${r.status}`)
  const list = await call('GET', '/portal/attendance?subjectType=staff')
  const found = (list.data?.records || []).some(x => String(x.userId?._id || x.userId) === String(staffUserId))
  ok('staff attendance appears in list', found)
}

// 4) Staff salary roster + generate (item 3, full parity)
{
  // Staff base-salary editor: set base via StaffProfile, roster should reflect it
  const base = await call('PATCH', `/portal/finance/staff/${staffUserId}/base`, { baseSalary: 60000, salaryCurrency: 'USD' })
  ok('set staff base salary (StaffProfile)', base.status === 200 && base.data?.baseSalary === 60000, `status ${base.status}`)

  const roster = await call('GET', `/portal/finance/salary/roster?month=${month}&year=${year}&scope=staff`)
  const row = (roster.data?.roster || []).find(r => String(r.userId?._id) === String(staffUserId))
  ok('staff appears in salary roster (scope=staff)', !!row, `total ${roster.data?.total}`)
  ok('roster reflects staff base + currency', row?.baseAmount === 60000 && row?.currency === 'USD', `base ${row?.baseAmount} ${row?.currency}`)

  // Generate WITHOUT baseAmount → should default to the StaffProfile base (60000 USD)
  const gen = await call('POST', '/portal/finance/salary/generate', { userId: staffUserId, month, year })
  ok('generate staff salary (defaults base from StaffProfile)',
    gen.status === 201 && gen.data?.subjectType === 'staff' && gen.data?.baseAmount === 60000 && gen.data?.currency === 'USD',
    `status ${gen.status}, base ${gen.data?.baseAmount} ${gen.data?.currency}, absentDays ${gen.data?.absentDays}`)

  if (gen.data?._id) {
    const paid = await call('PATCH', `/portal/finance/salary/${gen.data._id}`, { status: 'paid' })
    ok('mark staff salary paid + receipt', paid.status === 200 && paid.data?.status === 'paid' && !!paid.data?.receiptNo, `receipt ${paid.data?.receiptNo}`)
  }
}

// 5) Demo trial — time + create + announcement (item 1)
{
  const r = await call('POST', '/portal/demos', { studentName: 'Smoke Demo Student', time: '21:30', managerIds: [staffUserId] })
  ok('create demo with time + manager', r.status === 201 && r.data?.time === '21:30', `status ${r.status}`)
  const pend = await call('GET', '/portal/demos/pending-announcement')
  const found = (pend.data || []).some(d => d.studentName === 'Smoke Demo Student' && d.time === '21:30')
  ok('demo appears in pending-announcement', found, `pending ${(pend.data || []).length}`)
}

// 6) Complaint edit/delete routes exist (item 7) — expect 404 (route found, record missing), not 403/route-missing
{
  const fake = '507f1f77bcf86cd799439011'
  const patch = await call('PATCH', `/portal/notices/complaints/${fake}`, { text: 'x' })
  ok('complaint PATCH route reachable (perm ok)', patch.status === 404, `status ${patch.status}`)
  const del = await call('DELETE', `/portal/notices/complaints/${fake}`)
  ok('complaint DELETE route reachable (perm ok)', del.status === 404, `status ${del.status}`)
}

// 7) Live board returns boardState + due (item 5) — just verify shape, no started sessions expected
{
  const lb = await call('GET', '/portal/schedule/live-board')
  ok('live-board endpoint returns array', Array.isArray(lb.data), `status ${lb.status}, count ${Array.isArray(lb.data) ? lb.data.length : 'n/a'}`)
}

// Cleanup: delete the staff user
if (staffUserId) await call('DELETE', `/portal/users/${staffUserId}`)
console.log('\nSmoke complete.')
