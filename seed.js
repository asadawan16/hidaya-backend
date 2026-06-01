import 'dotenv/config'
import mongoose from 'mongoose'
import Admin from './models/Admin.js'

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI)

  const exists = await Admin.findOne({ email: process.env.ADMIN_EMAIL })
  if (exists) {
    console.log('Admin already exists:', exists.email)
  } else {
    await Admin.create({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      name: 'Hidaya Admin',
    })
    console.log('Admin created:', process.env.ADMIN_EMAIL)
  }

  await mongoose.disconnect()
}

seed().catch(console.error)
