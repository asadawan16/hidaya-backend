import 'dotenv/config'
import mongoose from 'mongoose'
import Role from './models/Role.js'
import User from './models/User.js'
import Admin from './models/Admin.js'
import { DEFAULT_ROLE_PERMISSIONS } from './config/permissions.js'

const ROLE_DEFINITIONS = [
  { key: 'super_admin', name: 'Super Admin', system: true },
  { key: 'admin', name: 'Admin', system: true },
  { key: 'principal', name: 'Principal', system: false },
  { key: 'coordinator', name: 'Coordinator', system: false },
  { key: 'qci', name: 'Quality Control Inspector', system: false },
  { key: 'qcm', name: 'Quality Control Manager', system: false },
  { key: 'tutor', name: 'Tutor', system: false },
  { key: 'student', name: 'Student', system: false },
]

async function seedPortal() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to MongoDB')

  // 1. Seed roles (upsert by key)
  console.log('\n--- Seeding Roles ---')
  const roleMap = {}

  for (const def of ROLE_DEFINITIONS) {
    const permissions = DEFAULT_ROLE_PERMISSIONS[def.key] || []
    const role = await Role.findOneAndUpdate(
      { key: def.key },
      { name: def.name, permissions, system: def.system },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
    roleMap[def.key] = role._id
    console.log(`  ${role.system ? '[SYSTEM]' : '[CUSTOM]'} ${role.key} — ${role.permissions.length} permissions`)
  }

  // 2. Migrate existing Admin accounts → User accounts
  console.log('\n--- Migrating Admins → Users ---')
  const admins = await Admin.find()

  if (admins.length === 0) {
    console.log('  No admin accounts to migrate')
  }

  for (const admin of admins) {
    const existing = await User.findOne({ email: admin.email })
    if (existing) {
      console.log(`  SKIP ${admin.email} — User already exists`)
      continue
    }

    // Copy password hash directly (no re-hash) by using create + manual set
    const user = new User({
      email: admin.email,
      password: 'placeholder', // will be overwritten
      displayName: admin.name || 'Admin',
      roles: [roleMap.super_admin],
      status: 'active',
    })
    // Overwrite password with existing hash directly (bypass pre-save hook)
    user.password = admin.password
    user.$__._skipPasswordHash = true
    await user.save({ validateModifiedOnly: true })

    // Reset password to the actual hash (the pre-save hook may have re-hashed)
    await User.updateOne({ _id: user._id }, { $set: { password: admin.password } })

    console.log(`  MIGRATED ${admin.email} → User (super_admin)`)
  }

  // 3. Summary
  const totalRoles = await Role.countDocuments()
  const totalUsers = await User.countDocuments()
  console.log(`\n--- Summary ---`)
  console.log(`  Roles: ${totalRoles}`)
  console.log(`  Users: ${totalUsers}`)

  await mongoose.disconnect()
  console.log('\nDone.')
}

seedPortal().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
