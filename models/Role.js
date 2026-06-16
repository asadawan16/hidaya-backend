import mongoose from 'mongoose'
import { ALL_PERMISSIONS } from '../config/permissions.js'

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

export default mongoose.model('Role', roleSchema)
