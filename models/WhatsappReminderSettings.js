import mongoose from 'mongoose'

/*
 * Singleton (key: 'default') — how tutors' class reminders are sent, set on
 * /portal/whatsapp → Class reminders.
 *
 * Reminders are always a TEMPLATE message: a parent hasn't necessarily written
 * to the academy in the last 24 hours, and outside that window Meta only
 * delivers approved templates. `params[i]` says what fills the template's
 * {{i+1}} — one of REMINDER_FIELDS — so the academy can word (and re-word) the
 * template in Meta without a code change.
 *
 * `bodyText` is the approved template body as Meta returned it when the admin
 * saved, used to render the exact text into the WhatsApp message log.
 */
export const REMINDER_FIELDS = [
  'student_first_name', 'student_name', 'class_time', 'class_date', 'course', 'tutor_name', 'class_link', 'academy_name',
]

const whatsappReminderSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  // Master switch — off stops every reminder without touching anyone's access
  enabled: { type: Boolean, default: false },
  templateName: { type: String, default: '' },
  language: { type: String, default: 'en_US' },
  params: { type: [{ type: String, enum: REMINDER_FIELDS }], default: [] },
  bodyText: { type: String, default: '' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

export default mongoose.model('WhatsappReminderSettings', whatsappReminderSettingsSchema)
