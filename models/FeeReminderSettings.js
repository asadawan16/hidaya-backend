import mongoose from 'mongoose'

// Singleton (`key: 'default'`) for the fee reminders sent as portal
// notifications (no SMTP or WhatsApp on this deployment):
//   - dayBefore: the evening/morning before a fee falls due, who is due tomorrow
//   - dailyDigest: every day, what is due today and what is still pending,
//     totalled in each currency
// Both go to the users holding any of `recipientRoles`. `notifyStudents` also
// tells a student's own portal account the day before their fee is due.
// lastDayBeforeOn / lastDigestOn (Karachi YYYY-MM-DD) stop a second send on
// the same day; the job catches up when the server wakes (Render free sleeps).
const feeReminderSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  dayBefore: { type: Boolean, default: true },
  dailyDigest: { type: Boolean, default: true },
  notifyStudents: { type: Boolean, default: false },
  // Hour of the day (Pakistan time, 0-23) from which the day's reminders go out
  sendHour: { type: Number, min: 0, max: 23, default: 9 },
  recipientRoles: { type: [String], default: ['super_admin', 'admin'] },
  lastDayBeforeOn: { type: String, default: '' },
  lastDigestOn: { type: String, default: '' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

export default mongoose.model('FeeReminderSettings', feeReminderSettingsSchema)
