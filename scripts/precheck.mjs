import 'dotenv/config'
import mongoose from 'mongoose'
import { loadAllModels } from './students-lib.mjs'
await mongoose.connect(process.env.MONGODB_URI)
await loadAllModels(process.cwd())
const c = async (n, f={}) => `${n}: ${await mongoose.model(n).countDocuments(f)}`
console.log(await c('Role'), '| student role:', !!(await mongoose.model('Role').findOne({key:'student'})))
console.log(await c('Student'))
console.log(await c('Family'))
console.log(await c('User'))
console.log('student accounts:', await mongoose.model('User').countDocuments({linkedStudentId:{$ne:null}}))
await mongoose.disconnect()
