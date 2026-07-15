// Reverses scripts/import-students.mjs: removes ALL students, families, student
// portal accounts, and any document referencing a student. Leaves admins,
// tutors, staff, roles and all non-student data untouched. Idempotent.
// Run from hidayah-backend:  node scripts/import-students.mjs   (import)
//                            node scripts/reset-students.mjs    (undo)
import 'dotenv/config'
import mongoose from 'mongoose'
import { loadAllModels, wipeStudentUniverse } from './students-lib.mjs'

const BE = process.cwd()

await mongoose.connect(process.env.MONGODB_URI)
console.log('Connected. Wiping student universe…')
await loadAllModels(BE)

const report = await wipeStudentUniverse({ log: console.log })

console.log('\nReset complete. Deleted:')
console.log(JSON.stringify(report, null, 2))
console.log(`\nStudents now: ${await mongoose.model('Student').countDocuments()}`)
console.log(`Families now: ${await mongoose.model('Family').countDocuments()}`)
console.log(`Student accounts now: ${await mongoose.model('User').countDocuments({ linkedStudentId: { $ne: null } })}`)

await mongoose.disconnect()
console.log('DONE')
