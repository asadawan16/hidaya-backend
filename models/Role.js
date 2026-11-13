import mongoose from 'mongoose'
import { ALL_PERMISSIONS, RETIRED_PERMISSIONS } from '../config/permissions.js'

const roleSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  permissions: {
    type: [String],
    default: [],
    validate: {
      validator(arr) {
        return arr.every(p => ALL_PERMISSIONS.includes(p))
      },
      message: 'One or more permissions are invalid',
    },
  },
  system: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true })

// A permission taken out of the catalog disappears from a role the next time
// it is saved, instead of making the save fail as "invalid".
roleSchema.pre('validate', function dropRetired(next) {
  if (this.permissions?.some(p => RETIRED_PERMISSIONS.includes(p))) {
    this.permissions = this.permissions.filter(p => !RETIRED_PERMISSIONS.includes(p))
  }
  next()
})

export default mongoose.model('Role', roleSchema)
