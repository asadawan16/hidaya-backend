import 'dotenv/config'
import mongoose from 'mongoose'
import { loadAllModels } from './students-lib.mjs'
await mongoose.connect(process.env.MONGODB_URI)
await loadAllModels(process.cwd())
const Student = mongoose.model('Student'), PL = mongoose.model('PermanentLesson'), CI = mongoose.model('CurriculumItem')

// Reversibility: is PermanentLesson swept by the reset? (has a studentId ref)
const swept = PL.schema.path('studentId')?.options?.ref === 'Student'
console.log('PermanentLesson swept by reset (studentId→Student ref):', swept)

console.log('Total curriculum items now:', await CI.countDocuments(), '| duas:', await CI.countDocuments({ track: 'dua' }))

// Pick a student with lessons and show a sample incl. an Urdu dua
const sid = (await PL.findOne().lean()).studentId
const stu = await Student.findById(sid, 'rollNo name status notes').lean()
console.log('\nSample student:', stu.rollNo, stu.name, '| status:', stu.status)
console.log('  notes:', stu.notes || '(none)')
const lessons = await PL.find({ studentId: sid }).populate('curriculumItemId', 'track label').lean()
console.log('  permanent lessons:', lessons.length)
const byTrack = {}
for (const l of lessons) { const t = l.curriculumItemId?.track || '?'; byTrack[t] = (byTrack[t] || 0) + 1 }
console.log('  by track:', JSON.stringify(byTrack))
const dua = lessons.find(l => l.curriculumItemId?.track === 'dua')
console.log('  sample dua lesson:', dua ? { label: dua.curriculumItemId.label, date: dua.completedDate, status: dua.status } : 'none')

// A student with a Quran-finish note
const noted = await Student.findOne({ notes: /Quran completed/ }, 'rollNo notes').lean()
console.log('\nStudent with finish note:', noted ? { roll: noted.rollNo, notes: noted.notes } : 'none')

// Integrity: any lesson missing tutor/curriculum?
console.log('\nLessons missing tutorId:', await PL.countDocuments({ tutorId: null }))
console.log('Lessons missing curriculumItemId:', await PL.countDocuments({ curriculumItemId: null }))
await mongoose.disconnect()
