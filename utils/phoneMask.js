/*
 * Phone numbers written inside a WhatsApp message ("Please save my number
 * 0300-5010415"). Staff on the WhatsApp Chats page never get the contact's own
 * number, so they mustn't get it — or any other — through the message text
 * either: the server swaps each one for NUMBER_HIDDEN before sending a message
 * to the staff view, and refuses a staff reply that contains one.
 *
 * A "number" is 7 to 15 digits, optionally led by + or 00, with spaces, dashes,
 * dots or brackets between them — in Western, Arabic-Indic (٠١٢) or Urdu (۰۱۲)
 * digits. Dates written with dashes or dots (06-11-2026, 2026.11.06) are left
 * alone. Like the fee filter it leans towards hiding: a long account or ID
 * number is hidden too. Checked when a message is READ, so it covers every
 * message already stored.
 */

export const NUMBER_HIDDEN = '[number hidden]'

const D = '[0-9٠-٩۰-۹]'
// A digit, then 6–14 more, each allowed up to two separators before it
const CANDIDATE = new RegExp(`(?:\\+|00)?\\(?${D}(?:[\\s\\-.()]{0,2}${D}){6,14}`, 'g')
const DATE = /^\d{1,4}[-.]\d{1,2}[-.]\d{1,4}$/

const toLatin = (s) => s
  .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))

function isPhone(match) {
  const latin = toLatin(match.trim())
  const digits = latin.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return false
  return !DATE.test(latin)
}

/** The text with every phone number replaced by NUMBER_HIDDEN. */
export function maskPhoneNumbers(text) {
  if (!text) return text || ''
  return String(text).replace(CANDIDATE, (m) => {
    if (!isPhone(m)) return m
    // Keep the space the match may have started or ended on
    const lead = m.match(/^\s*/)[0]
    const trail = m.match(/\s*$/)[0]
    return `${lead}${NUMBER_HIDDEN}${trail}`
  })
}

/** Does the text contain a phone number? */
export function containsPhoneNumber(text) {
  return maskPhoneNumbers(text) !== String(text || '')
}
