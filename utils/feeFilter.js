/*
 * Does a WhatsApp message talk about money? Staff on the WhatsApp Chats page
 * (whatsapp.chat without whatsapp.inbox) never receive the content of one that
 * does — the server sends a "hidden, mentions fees" placeholder instead.
 *
 * Keyword-based, in English, Roman Urdu and Urdu script, so it can miss a fee
 * message or hide one that isn't (the client was told so in the proposal).
 * When it has to choose it leans towards hiding. A photo of a bank receipt with
 * no caption can't be recognised at all.
 *
 * Checked when a message is READ, not stored, so changing a list here applies
 * to every message already in the database.
 */

// Whole words (Latin script). Kept specific enough that ordinary class talk
// ("pay attention", "class is due at 8", "report card") stays visible.
const WORDS = [
  // English
  'fee', 'fees', 'tuition fee', 'payment', 'payments', 'paid', 'unpaid', 'prepaid', 'paying', 'payable', 'repay',
  'dues', 'overdue', 'amount due', 'due amount', 'invoice', 'invoices', 'receipt', 'receipts', 'refund', 'refunds',
  'refunded', 'installment', 'installments', 'instalment', 'instalments', 'discount', 'discounts', 'concession',
  'scholarship', 'amount', 'balance', 'outstanding', 'bank', 'bank transfer', 'transferred', 'deposit', 'deposited',
  'iban', 'account number', 'account no', 'acc no', 'jazzcash', 'jazz cash', 'easypaisa', 'easy paisa', 'sadapay',
  'nayapay', 'raast', 'paypal', 'stripe', 'payment link', 'pay link', 'voucher', 'billing', 'bill', 'bills',
  'charges', 'charged', 'price', 'prices', 'pricing', 'cost', 'costs', 'money', 'cash', 'transaction', 'tid',
  'rupee', 'rupees', 'dollar', 'dollars', 'pound', 'pounds', 'euro', 'euros', 'pkr', 'usd', 'gbp', 'cad', 'aed', 'riyal',
  'salary',
  // Roman Urdu
  'paisay', 'paise', 'paisa', 'pese', 'paison', 'peson', 'raqam', 'rakam', 'adaigi', 'adayegi', 'adaegi', 'adaygi',
  'qist', 'qistain', 'kist', 'baqaya', 'bakaya', 'baqaaya', 'wajibat', 'wajib ul ada', 'rupay', 'rupaye', 'rupey',
  'rasid', 'raseed', 'jama karwa', 'jama karwai', 'jama karwadi', 'jama kara di', 'jama kar di', 'jama krwa',
  'bhejwa di', 'transfer kar', 'transfer kr', 'fees bhej', 'fee bhej', 'paise bhej', 'paisay bhej',
]

// "pay" on its own, but not "pay attention"
const PAY = /\bpay(?!\s+(?:attention|heed))\b/

// Money written as a figure: "Rs 5000", "5,000 rs", "$40", "40$", "£30", "5 hazar", "PKR5000"
const AMOUNT = [
  /\brs\.?\s*\d/, /\d\s*rs\b/, /[$£€]\s*\d/, /\d\s*[$£€]/, /\b\d+(?:[.,]\d+)?\s*(?:hazar|hazaar|hzr|thousand)\b/,
  /\b(?:pkr|usd|gbp|cad|aed|eur)\s*\d/, /\d\s*(?:pkr|usd|gbp|cad|aed|eur)\b/,
]

// Urdu script has no reliable word boundaries — substring match. "ادا" and
// "جمع" alone are left out: they also mean performing a prayer and Friday.
const URDU = [
  'فیس', 'ادائیگی', 'ادائگی', 'واجب الادا', 'واجبات', 'رقم', 'پیسے', 'پیسہ', 'پیسوں', 'روپے', 'روپیہ', 'روپیے',
  'بقایا', 'بقایاجات', 'قسط', 'اقساط', 'رسید', 'بینک', 'اکاؤنٹ', 'اکاونٹ', 'جمع کروا', 'جمع کرا', 'ٹرانسفر',
  'ایزی پیسہ', 'ایزی پیسا', 'جاز کیش', 'ڈسکاؤنٹ', 'رعایت', 'تنخواہ', 'ہزار روپے', 'معاوضہ',
]

// Template names like fee_reminder / payment_due / invoice_sent
const TEMPLATE_NAME = /(fee|pay|invoice|dues|receipt|refund|bill|amount|balance)/

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const WORD_RE = new RegExp(`\\b(?:${WORDS.map(w => escape(w).replace(/ /g, '\\s+')).join('|')})\\b`)

function normalise(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    // Arabic-keyboard letters → their Urdu forms (ي→ی, ك→ک, ہ/ه)
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/ه/g, 'ہ')
    // Zero-width joiners split words invisibly
    .replace(/[​-‏⁠]/g, '')
}

export function mentionsFees(text) {
  const t = normalise(text)
  if (!t.trim()) return false
  if (WORD_RE.test(t) || PAY.test(t)) return true
  if (AMOUNT.some(re => re.test(t))) return true
  return URDU.some(w => t.includes(w))
}

// A stored WhatsappMessage (or the same shape): its text, a document's file
// name, and the template it was sent with.
export function isFeeMessage(msg) {
  if (!msg) return false
  if (msg.templateName && TEMPLATE_NAME.test(String(msg.templateName).toLowerCase())) return true
  return mentionsFees(msg.text) || mentionsFees(msg.media?.filename)
}
