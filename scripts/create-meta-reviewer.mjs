// Creates (or removes) the portal account Meta's App Review team signs in with
// to test the WhatsApp permissions.
//
// The account's only role is `meta_reviewer`, holding just `whatsapp.manage`,
// so it can open /portal/whatsapp and nothing else (its dashboard is empty —
// custom roles get no charts). Delete it once the review is decided.
//
//   node scripts/create-meta-reviewer.mjs            # create; prints the password once
//   node scripts/create-meta-reviewer.mjs --reset    # new password for the existing account
//   node scripts/create-meta-reviewer.mjs --remove   # delete the account and the role
import 'dotenv/config'
import crypto from 'crypto'
import mongoose from 'mongoose'
import Role from '../models/Role.js'
import User from '../models/User.js'

const EMAIL = 'meta-reviewer@hidaya.online'
const ROLE_KEY = 'meta_reviewer'
const mode = process.argv.includes('--remove') ? 'remove' : process.argv.includes('--reset') ? 'reset' : 'create'

// 16 chars, mixed classes, no look-alikes — easy to paste into Meta's form
function makePassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '@#%+=']
  const all = sets.join('')
  const pick = (s) => s[crypto.randomInt(s.length)]
  const chars = [...sets.map(pick), ...Array.from({ length: 12 }, () => pick(all))]
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]] }
  return chars.join('')
}

await mongoose.connect(process.env.MONGODB_URI)

if (mode === 'remove') {
  const u = await User.deleteOne({ email: EMAIL })
  const r = await Role.deleteOne({ key: ROLE_KEY })
  console.log(`Removed ${u.deletedCount} user and ${r.deletedCount} role.`)
} else {
  const role = await Role.findOneAndUpdate(
    { key: ROLE_KEY },
    { $setOnInsert: { key: ROLE_KEY, name: 'Meta Reviewer' }, $set: { permissions: ['whatsapp.manage'] } },
    { upsert: true, new: true, runValidators: true },
  )

  let user = await User.findOne({ email: EMAIL })
  if (user && mode === 'create') {
    console.log(`${EMAIL} already exists — run with --reset for a new password.`)
  } else {
    const password = makePassword()
    if (!user) user = new User({ email: EMAIL, displayName: 'Meta Reviewer', roles: [role._id], status: 'active' })
    user.password = password
    user.roles = [role._id]
    user.status = 'active'
    await user.save()
    console.log(`Portal URL: https://hidaya.online/portal/login`)
    console.log(`Email:      ${EMAIL}`)
    console.log(`Password:   ${password}`)
    console.log(`Role:       Meta Reviewer (whatsapp.manage only)`)
  }
}

await mongoose.disconnect()
