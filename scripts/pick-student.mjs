import 'dotenv/config'
import mongoose from 'mongoose'
import { loadAllModels } from './students-lib.mjs'
await mongoose.connect(process.env.MONGODB_URI)
await loadAllModels(process.cwd())
const Student = mongoose.model('Student'), PL = mongoose.model('PermanentLesson'), User = mongoose.model('User')

// top students by permanent-lesson count
const top = await PL.aggregate([
  { $group: { _id: '$studentId', n: { $sum: 1 } } },
  { $sort: { n: -1 } }, { $limit: 8 },
])
console.log('Top students by permanent-lesson count:')
for (const t of top) {
  const s = await Student.findById(t._id, 'rollNo name status userId').lean()
  const u = s.userId ? await User.findById(s.userId, 'email').lean() : null
  console.log(`  _id=${t._id}  ${s.rollNo}  ${s.name}  status=${s.status}  lessons=${t.n}  login=${u?.email || '(no account)'}`)
}
await mongoose.disconnect()
