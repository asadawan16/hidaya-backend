/*
 * WhatsApp ids are international digits with no '+' (923001234567). Staff type
 * numbers however they like — "+92 300 1234567", "0092…", "0300-1234567".
 */

// International digits only: "+92 300-1234567" / "0092…" → "923001234567".
// Anything still starting with 0 is a local number and can't be addressed.
export function toWaId(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  return d.length >= 8 && d.length <= 15 && !d.startsWith('0') ? d : ''
}

// Most of the academy's numbers are Pakistani, and plenty were saved in local
// form. For a student who is in Pakistan, "0300 1234567" can only mean +92 300
// 1234567, and "+92 0300…" is the same number with a stray trunk zero. For
// anyone else a local number is ambiguous and stays unusable.
function isPakistani(student) {
  const country = String(student?.country || '').trim().toLowerCase()
  if (country) return country === 'pakistan' || country === 'pk'
  return !student?.timezone || student.timezone === 'Asia/Karachi'
}

export function toWaIdForStudent(raw, student) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (/^920\d{10}$/.test(digits)) return `92${digits.slice(3)}`
  if (isPakistani(student) && /^03\d{9}$/.test(digits)) return `92${digits.slice(1)}`
  return toWaId(raw)
}

const RELATION_LABEL = {
  father: 'Father', mother: 'Mother', grandfather: 'Grandfather', grandmother: 'Grandmother',
  uncle: 'Uncle', aunty: 'Aunty', brother: 'Brother', sister: 'Sister', other: 'Guardian',
}

/*
 * Who a student's WhatsApp messages go to, in order:
 *   1. a guardian ticked as the WhatsApp recipient
 *   2. the student's own WhatsApp number
 *   3. any other guardian's phone
 *   4. the student's legacy phone
 * The first entry with a usable number wins. Returns null when there is none,
 * with `reason` telling staff why ('none' — nothing on file, 'invalid' —
 * something on file but not in a form WhatsApp can address).
 */
export function resolveStudentRecipient(student) {
  const guardians = Array.isArray(student?.guardians) ? student.guardians : []
  const candidates = [
    ...guardians.filter(g => g.isWhatsappRecipient).map(g => ({ type: 'guardian', label: RELATION_LABEL[g.relation] || 'Guardian', raw: g.phone })),
    { type: 'student', label: 'Student', raw: student?.whatsappNumber },
    ...guardians.filter(g => !g.isWhatsappRecipient).map(g => ({ type: 'guardian', label: RELATION_LABEL[g.relation] || 'Guardian', raw: g.phone })),
    { type: 'student', label: 'Student', raw: student?.phone },
  ]
  let sawNumber = false
  for (const c of candidates) {
    if (!String(c.raw || '').trim()) continue
    sawNumber = true
    const waId = toWaIdForStudent(c.raw, student)
    if (waId) return { recipient: { type: c.type, label: c.label, waId }, reason: '' }
  }
  return { recipient: null, reason: sawNumber ? 'invalid' : 'none' }
}

// Who a WhatsApp contact is to a student — "Mother", "Student"… — or '' when
// the number isn't one of theirs. Last 10 digits, like findStudentIdByPhone.
const tail10 = (raw) => String(raw || '').replace(/\D/g, '').slice(-10)

export function contactLabelFor(student, waId) {
  const t = tail10(waId)
  if (t.length < 7 || !student) return ''
  for (const g of student.guardians || []) {
    if (tail10(g.phone) === t) return RELATION_LABEL[g.relation] || 'Guardian'
  }
  if (tail10(student.whatsappNumber) === t || tail10(student.phone) === t) return 'Student'
  return ''
}
