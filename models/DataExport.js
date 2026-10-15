import mongoose from 'mongoose'

// One row per completed portal data export (the disaster-recovery backup on
// /portal/data-export). The newest row drives the super admin's weekly reminder.
const dataExportSchema = new mongoose.Schema({
  exportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  fileName: { type: String, default: '' },
  totalRecords: { type: Number, default: 0 },
  fileCount: { type: Number, default: 0 },
  bytes: { type: Number, default: 0 },
  durationMs: { type: Number, default: 0 },
}, { timestamps: true })

dataExportSchema.index({ createdAt: -1 })

export default mongoose.model('DataExport', dataExportSchema)
