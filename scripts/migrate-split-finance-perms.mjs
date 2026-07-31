// Add-only migration: split the portal billing surface off the coarse finance.*
// permission into its own granular perms, and introduce the new revenue.read
// permission for the Revenue analytics dashboard.
//
// WHY: previously every finance tab (Payments, Payment Links, Discount Codes,
// Plans, Revenue) was gated by finance.read/finance.manage, so any role granted
// finance access (e.g. a Quality Control Manager) saw the whole billing surface.
// The tabs now follow their own domain permissions. This backfills the new perms
// onto the DEFAULT management roles that already had finance access so THEY keep
// what they had — every other/custom role is left untouched and therefore loses
// the billing tabs it was never explicitly granted.
//
// Uses $addToSet keyed by role.key — NO existing permission or customization is
// removed. Roles not in the map below (custom roles, qcm/qci, tutor, student…)
// are never modified. Idempotent.
//
//   node scripts/migrate-split-finance-perms.mjs           # dry run (default)
//   node scripts/migrate-split-finance-perms.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const APPLY = process.argv.includes('--apply')

// Per default-role additions. Only these keys are touched.
const FULL_BILLING = [
  'payment.read', 'payment.create', 'payment.update',
  'payment_link.read', 'payment_link.create', 'payment_link.send', 'payment_link.delete',
  'plan.read', 'plan.update',
  'discount_code.read', 'discount_code.create', 'discount_code.update', 'discount_code.delete',
]
const READ_BILLING = ['payment.read', 'payment_link.read', 'plan.read', 'discount_code.read']

// super_admin / admin already carry the granular billing perms in their stored
// arrays (they were seeded from ALL_PERMISSIONS) — they only need revenue.read.
// principal had finance.read+manage (full billing); coordinator had finance.read
// (read-only billing). Backfill to preserve their prior effective access.
const ADDITIONS = {
  super_admin: ['revenue.read'],
  admin: ['revenue.read'],
  principal: ['revenue.read', ...FULL_BILLING],
  coordinator: ['revenue.read', ...READ_BILLING],
}

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const roles = await Role.find().select('key name permissions').lean()
let changed = 0

for (const role of roles) {
  const wanted = ADDITIONS[role.key]
  if (!wanted) {
    // Not a targeted default role — leave completely untouched.
    continue
  }
  const perms = role.permissions || []
  const missing = wanted.filter(p => !perms.includes(p))
  if (missing.length === 0) {
    console.log(`SKIP    ${role.key} — already has all target perms`)
    continue
  }

  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${role.key} — adding [${missing.join(', ')}]`)
  changed++

  if (APPLY) {
    await Role.updateOne(
      { _id: role._id },
      { $addToSet: { permissions: { $each: missing } } },
    )
  }
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')

await mongoose.disconnect()
