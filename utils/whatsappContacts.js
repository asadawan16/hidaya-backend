import WhatsappContact from '../models/WhatsappContact.js'
import WhatsappChat from '../models/WhatsappChat.js'

/*
 * The WhatsApp contact book (models/WhatsappContact.js): saved names for
 * numbers, from the portal, the office phone or an uploaded contacts file,
 * and the copy of each name on its WhatsappChat row (`savedName`, which the
 * chat list shows and searches).
 */

// "+92 300 1234567", "0300-1234567", "00923001234567" and the waId
// "923001234567" all → "3001234567". Short strings aren't phone numbers.
export function phoneKey(raw) {
  let digits = String(raw || '').replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length < 7) return ''
  return digits.slice(-10)
}

export const NAME_MAX = 80
export function cleanName(raw) {
  // eslint-disable-next-line no-control-regex
  return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

// The name a contact is shown under, and where it came from
export function nameOf(contact) {
  if (!contact) return { name: '', source: '' }
  if (contact.customName) return { name: contact.customName, source: 'portal' }
  if (contact.phoneName) return { name: contact.phoneName, source: 'phone' }
  if (contact.importName) return { name: contact.importName, source: 'import' }
  return { name: '', source: '' }
}

export async function contactFor(waId) {
  const key = phoneKey(waId)
  return key ? WhatsappContact.findOne({ key }).lean() : null
}

/*
 * Copy saved names onto the chat rows. With `keys`, only the chats of those
 * numbers; without, every chat. Returns the ids of the chats whose name changed.
 */
export async function refreshChatNames(keys = null) {
  const wanted = keys ? new Set(keys.filter(Boolean)) : null
  if (wanted && !wanted.size) return []
  const chats = await WhatsappChat.find({}).select('waId savedName nameSource').lean()
  const mine = chats.map(c => ({ ...c, key: phoneKey(c.waId) })).filter(c => c.key && (!wanted || wanted.has(c.key)))
  if (!mine.length) return []
  const contacts = await WhatsappContact.find({ key: { $in: [...new Set(mine.map(c => c.key))] } }).lean()
  const byKey = new Map(contacts.map(c => [c.key, c]))
  const ops = []
  for (const chat of mine) {
    const { name, source } = nameOf(byKey.get(chat.key))
    if ((chat.savedName || '') === name && (chat.nameSource || '') === source) continue
    ops.push({ updateOne: { filter: { _id: chat._id }, update: { $set: { savedName: name, nameSource: source } } } })
  }
  if (ops.length) await WhatsappChat.bulkWrite(ops, { ordered: false })
  return ops.map(op => op.updateOne.filter._id)
}

// Keep the longest digit string we have seen for a number (it is the one most likely to carry the country code)
const longer = (a, b) => (String(b || '').length > String(a || '').length ? b : a)

/*
 * The office phone's contacts, from Meta's `smb_app_state_sync` webhook:
 * state_sync: [{ type: 'contact', action: 'add' | 'remove',
 *                contact: { phone_number, full_name, first_name } }]
 * An edit arrives as another 'add'. Returns the keys that changed.
 */
export async function recordPhoneContacts(stateSync) {
  const keys = []
  for (const item of stateSync || []) {
    if (item?.type && item.type !== 'contact') continue
    const c = item?.contact || {}
    const key = phoneKey(c.phone_number)
    if (!key) continue
    const digits = String(c.phone_number).replace(/\D/g, '')
    const name = item.action === 'remove' ? '' : cleanName(c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' '))
    const existing = await WhatsappContact.findOne({ key }).select('digits').lean()
    await WhatsappContact.updateOne(
      { key },
      { $set: { phoneName: name, phoneSyncedAt: new Date(), digits: longer(existing?.digits, digits) } },
      { upsert: true },
    )
    keys.push(key)
  }
  return keys
}

/*
 * An uploaded contacts file, already read in the browser into
 * [{ name, phone }]. A number already named by an earlier file keeps that
 * name unless `overwrite`; names typed in the portal or synced from the phone
 * are never touched (they rank above a file anyway).
 */
export const IMPORT_MAX = 5000
export async function importContacts(list, { overwrite = false } = {}) {
  const rows = new Map()
  let skipped = 0
  for (const entry of (Array.isArray(list) ? list : []).slice(0, IMPORT_MAX)) {
    const key = phoneKey(entry?.phone)
    const name = cleanName(entry?.name)
    if (!key || !name) { skipped++; continue }
    rows.set(key, { name, digits: String(entry.phone).replace(/\D/g, '').replace(/^00/, '') })
  }
  if (!rows.size) return { added: 0, updated: 0, unchanged: 0, skipped, keys: [] }

  const existing = new Map((await WhatsappContact.find({ key: { $in: [...rows.keys()] } }).select('key importName digits').lean()).map(c => [c.key, c]))
  const now = new Date()
  const ops = []
  let added = 0, updated = 0, unchanged = 0
  const keys = []
  for (const [key, { name, digits }] of rows) {
    const have = existing.get(key)
    if (!have) {
      ops.push({ insertOne: { document: { key, digits, importName: name, importedAt: now } } })
      added++; keys.push(key)
    } else if (have.importName === name || (have.importName && !overwrite)) {
      unchanged++
    } else {
      ops.push({ updateOne: { filter: { key }, update: { $set: { importName: name, importedAt: now, digits: longer(have.digits, digits) } } } })
      updated++; keys.push(key)
    }
  }
  if (ops.length) await WhatsappContact.bulkWrite(ops, { ordered: false })
  return { added, updated, unchanged, skipped, keys }
}

// A name typed in the portal for one number ('' takes it away again)
export async function setCustomName(waId, name, userId) {
  const key = phoneKey(waId)
  if (!key) return null
  const clean = cleanName(name)
  const digits = String(waId).replace(/\D/g, '')
  await WhatsappContact.updateOne(
    { key },
    { $set: { customName: clean, customBy: clean ? userId : null }, $setOnInsert: { digits } },
    { upsert: true },
  )
  return key
}

export async function contactBookSummary() {
  const [total, fromPhone, imported, custom, lastImport, lastPhone] = await Promise.all([
    WhatsappContact.countDocuments({ $or: [{ customName: { $ne: '' } }, { phoneName: { $ne: '' } }, { importName: { $ne: '' } }] }),
    WhatsappContact.countDocuments({ phoneName: { $ne: '' } }),
    WhatsappContact.countDocuments({ importName: { $ne: '' } }),
    WhatsappContact.countDocuments({ customName: { $ne: '' } }),
    WhatsappContact.findOne({ importedAt: { $ne: null } }).sort({ importedAt: -1 }).select('importedAt').lean(),
    WhatsappContact.findOne({ phoneSyncedAt: { $ne: null } }).sort({ phoneSyncedAt: -1 }).select('phoneSyncedAt').lean(),
  ])
  const named = await WhatsappChat.countDocuments({ lastMessageAt: { $ne: null }, savedName: { $nin: ['', null] } })
  const chats = await WhatsappChat.countDocuments({ lastMessageAt: { $ne: null } })
  return {
    total, fromPhone, imported, custom,
    lastImportAt: lastImport?.importedAt || null,
    lastPhoneSyncAt: lastPhone?.phoneSyncedAt || null,
    chats, namedChats: named,
  }
}
