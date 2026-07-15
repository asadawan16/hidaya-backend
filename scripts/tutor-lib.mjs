// Shared helpers for mapping the sheets' numeric tutor tokens → TutorProfiles,
// used by both import-tutor-changes.mjs and import-daily-lessons.mjs.
import mongoose from 'mongoose'

// Sheet tutor token (a bare number like 4 / 10) → TutorProfile.tutorId ("T04").
export function tokenToTutorId(raw) {
  const n = String(raw ?? '').trim()
  if (!n || !/^\d+$/.test(n)) return null
  return 'T' + n.padStart(2, '0')
}

// Returns { resolve(rawToken) → TutorProfile _id | null, created: [tutorId…] }.
// Any referenced tutor that has no TutorProfile is created as an INACTIVE
// placeholder tutor + suspended login account so the reference resolves.
export async function makeTutorResolver() {
  const TutorProfile = mongoose.model('TutorProfile')
  const User = mongoose.model('User')
  const Role = mongoose.model('Role')
  const tutorRole = await Role.findOne({ key: 'tutor' })
  const cache = new Map()
  const created = []

  async function resolve(raw) {
    const tid = tokenToTutorId(raw)
    if (!tid) return null
    if (cache.has(tid)) return cache.get(tid)
    let tp = await TutorProfile.findOne({ tutorId: tid })
    if (!tp) {
      const email = `${tid.toLowerCase()}.import@hidaya.online`
      let user = await User.findOne({ email })
      if (!user) {
        user = await User.create({
          email,
          password: 'Hidaya@123',
          displayName: `Tutor ${tid}`,
          roles: tutorRole ? [tutorRole._id] : [],
          status: 'suspended',
        })
      }
      tp = await TutorProfile.create({ tutorId: tid, userId: user._id, name: `Tutor ${tid}`, status: 'inactive' })
      created.push(tid)
    }
    cache.set(tid, tp._id)
    return tp._id
  }

  return { resolve, created }
}
