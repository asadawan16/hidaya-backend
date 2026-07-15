import 'dotenv/config'
import mongoose from 'mongoose'
import { loadAllModels } from './students-lib.mjs'
await mongoose.connect(process.env.MONGODB_URI)
await loadAllModels(process.cwd())
const Student = mongoose.model('Student'), Family = mongoose.model('Family'), User = mongoose.model('User')

console.log('Non-student users (staff/admin/tutor, must be preserved):', await User.countDocuments({ linkedStudentId: null }))

// A left student => no account; an active student => account
const laiba = await Student.findOne({ rollNo: 'HID01' }).populate('familyId')
console.log('\nHID01 LAIBA (Left):', { name: laiba.name, status: laiba.status, userId: laiba.userId, family: laiba.familyId?.familyCode, tz: laiba.timezone })
const hadi = await Student.findOne({ rollNo: 'HID06' }).populate('familyId userId')
console.log('HID06 AbdulHadiButt (Active):', { name: hadi.name, status: hadi.status, accEmail: hadi.userId?.email, family: hadi.familyId?.familyCode })

// duplicate handling
const dup = await Student.find({ rollNo: { $in: ['HID467', 'HID467B'] } })
console.log('\nHID467 pair:', dup.map(s => ({ roll: s.rollNo, name: s.name, status: s.status, hasAcc: !!s.userId })))

// family membership sanity: HF01 should contain the 4 HID01-04 students
const hf01 = await Family.findOne({ familyCode: 'HF01' }).populate('members', 'rollNo name')
console.log('\nHF01 members:', hf01.members.map(m => m.rollNo))

// sect + placement + special-needs mapping sample
const withSect = await Student.findOne({ sect: { $ne: '' } }, 'rollNo sect placementLevel')
console.log('Sample sect/placement:', withSect ? { roll: withSect.rollNo, sect: withSect.sect, placement: withSect.placementLevel } : 'none')
const autism = await Student.findOne({ 'specialNeeds.type': 'autism' }, 'rollNo name specialNeeds')
console.log('Autism student:', autism ? { roll: autism.rollNo, needs: autism.specialNeeds } : 'none')

// account email format
const acc = await User.findOne({ linkedStudentId: { $ne: null } }, 'email').sort({ email: 1 })
console.log('\nSample account email:', acc.email)
console.log('Any account email NOT @hidaya.online:', await User.countDocuments({ linkedStudentId: { $ne: null }, email: { $not: /@hidaya\.online$/ } }))
await mongoose.disconnect()
