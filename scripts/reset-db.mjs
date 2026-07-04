// One-off dev reset: drop ALL collections, seed default roles, create a
// single super admin portal user (+ legacy Admin) from .env credentials.
// Run with cwd = hidayah-backend.
import 'dotenv/config'
import mongoose from 'mongoose'
import { pathToFileURL } from 'url'

const BE = process.cwd().replace(/\\/g, '/')
const load = (p) => import(pathToFileURL(`${BE}/${p}`)).then(m => m.default ?? m)

await mongoose.connect(process.env.MONGODB_URI)
const db = mongoose.connection.db

const cols = await db.listCollections().toArray()
for (const c of cols) {
  await db.dropCollection(c.name)
}
console.log(`Dropped ${cols.length} collections`)

const Role = await load('models/Role.js')
const User = await load('models/User.js')
const Admin = await load('models/Admin.js')
const { DEFAULT_ROLE_PERMISSIONS } = await import(pathToFileURL(`${BE}/config/permissions.js`))

const pretty = (k) => k.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
const roles = {}
for (const [key, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
  roles[key] = await Role.create({ key, name: pretty(key), permissions })
}
console.log(`Seeded ${Object.keys(roles).length} roles: ${Object.keys(roles).join(', ')}`)

const email = process.env.ADMIN_EMAIL
const password = process.env.ADMIN_PASSWORD
if (!email || !password) {
  console.error('ADMIN_EMAIL / ADMIN_PASSWORD missing from .env — no user created')
  process.exit(1)
}

const user = await User.create({
  email,
  displayName: 'Super Admin',
  password,
  status: 'active',
  roles: [roles.super_admin._id],
})
console.log(`Portal super admin created: ${user.email} (password = ADMIN_PASSWORD from .env)`)

// Legacy admin-dashboard account (same credentials)
try {
  await Admin.create({ email, password, name: 'Super Admin' })
  console.log(`Admin dashboard account created: ${email}`)
} catch (e) {
  console.log(`Admin dashboard account skipped: ${e.message}`)
}

const finalCols = await db.listCollections().toArray()
console.log(`DB now has ${finalCols.length} collections (roles + users)`)
await mongoose.disconnect()
console.log('DONE')
