import 'dotenv/config'
import mongoose from 'mongoose'
import connectDB from './config/db.js'
import Student from './models/Student.js'
import PaymentLink from './models/PaymentLink.js'
import Payment from './models/Payment.js'

await connectDB()

// Clean previous seed data (optional — remove if you want to keep existing)
const existingStudents = await Student.find({ email: { $in: ['ahmed.khan@example.com', 'sarah.ali@example.com', 'fatima.hassan@example.com'] } })
if (existingStudents.length > 0) {
  const ids = existingStudents.map(s => s._id)
  await Payment.deleteMany({ student: { $in: ids } })
  await PaymentLink.deleteMany({ student: { $in: ids } })
  await Student.deleteMany({ _id: { $in: ids } })
  console.log('Cleaned previous seed data')
}

// Create students
const [ahmed, sarah, fatima] = await Student.insertMany([
  { name: 'Ahmed Khan', email: 'ahmed.khan@example.com', phone: '+92 321 1234567', notes: 'Enrolled in Tajweed course, 3 days/week' },
  { name: 'Sarah Ali', email: 'sarah.ali@example.com', phone: '+1 631 555 0199', notes: 'UK-based student, pays in GBP' },
  { name: 'Fatima Hassan', email: 'fatima.hassan@example.com', phone: '+44 7911 123456', notes: 'New student, trial completed' },
])
console.log(`Created 3 students: ${ahmed.name}, ${sarah.name}, ${fatima.name}`)

// Helper to create a payment link + payments
async function createLinkWithPayments(student, linkData, payments) {
  const link = await PaymentLink.create({
    payeeName: student.name,
    payeeEmail: student.email,
    payeePhone: student.phone,
    student: student._id,
    ...linkData,
  })

  for (const p of payments) {
    await Payment.create({
      studentName: student.name,
      studentEmail: student.email,
      studentPhone: student.phone,
      plan: linkData.description,
      amount: linkData.amount,
      currency: linkData.currency || 'PKR',
      student: student._id,
      paymentLink: link._id,
      gatewayOrderId: `PL-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      ...p,
    })
    // Small delay to ensure unique timestamps
    await new Promise(r => setTimeout(r, 50))
  }

  // Update link status based on latest payment
  const lastPayment = payments[payments.length - 1]
  if (lastPayment.status === 'completed' && linkData.expiresAfterPayment !== false) {
    link.status = 'completed'
  }
  const latestPayment = await Payment.findOne({ paymentLink: link._id }).sort({ createdAt: -1 })
  if (latestPayment) link.payment = latestPayment._id
  await link.save()

  return link
}

// ─── Ahmed Khan: Multiple separate links (monthly payments) ───
console.log('\nSeeding Ahmed Khan — 4 separate monthly payment links...')

await createLinkWithPayments(ahmed, {
  description: 'March 2026 — Tajweed 3 Days/Week',
  amount: 14000,
  currency: 'PKR',
  items: ['Tajweed course', '3 sessions/week', 'March 2026'],
  listType: 'numbered',
  expiresAfterPayment: true,
}, [
  { status: 'completed', gatewayResult: 'SUCCESS', gatewayTransactionId: 'TXN-001', createdAt: new Date('2026-03-05') },
])

await createLinkWithPayments(ahmed, {
  description: 'April 2026 — Tajweed 3 Days/Week',
  amount: 14000,
  currency: 'PKR',
  items: ['Tajweed course', '3 sessions/week', 'April 2026'],
  listType: 'numbered',
  expiresAfterPayment: true,
}, [
  { status: 'completed', gatewayResult: 'SUCCESS', gatewayTransactionId: 'TXN-002', createdAt: new Date('2026-04-03') },
])

await createLinkWithPayments(ahmed, {
  description: 'May 2026 — Tajweed 3 Days/Week',
  amount: 14000,
  currency: 'PKR',
  items: ['Tajweed course', '3 sessions/week', 'May 2026'],
  listType: 'numbered',
  expiresAfterPayment: true,
}, [
  { status: 'completed', gatewayResult: 'SUCCESS', gatewayTransactionId: 'TXN-003', createdAt: new Date('2026-05-02') },
])

await createLinkWithPayments(ahmed, {
  description: 'June 2026 — Tajweed 3 Days/Week',
  amount: 14000,
  currency: 'PKR',
  items: ['Tajweed course', '3 sessions/week', 'June 2026'],
  listType: 'numbered',
  expiresAfterPayment: true,
}, [
  { status: 'pending', createdAt: new Date('2026-06-01') },
])

console.log('  4 links created (3 completed, 1 pending)')

// ─── Sarah Ali: One reusable link used multiple times (GBP) ───
console.log('\nSeeding Sarah Ali — 1 reusable link with 4 payments...')

await createLinkWithPayments(sarah, {
  description: 'Monthly Quran Reading — Recurring',
  amount: 35,
  currency: 'GBP',
  items: ['Quran Reading course', '2 sessions/week', 'Monthly recurring'],
  listType: 'bullet',
  expiresAfterPayment: false, // REUSABLE
}, [
  { status: 'completed', gatewayResult: 'SUCCESS', gatewayTransactionId: 'TXN-UK-001', createdAt: new Date('2026-02-10') },
  { status: 'completed', gatewayResult: 'SUCCESS', gatewayTransactionId: 'TXN-UK-002', createdAt: new Date('2026-03-08') },
  { status: 'failed', gatewayResult: 'FAILED', gatewayResultCode: 'DECLINED', createdAt: new Date('2026-04-05') },
  { status: 'completed', gatewayResult: 'SUCCESS', gatewayTransactionId: 'TXN-UK-003', createdAt: new Date('2026-04-07') },
])

// Also give Sarah a second link in USD (one-time)
await createLinkWithPayments(sarah, {
  description: 'Registration Fee',
  amount: 50,
  currency: 'USD',
  items: ['One-time registration fee'],
  listType: 'bullet',
  expiresAfterPayment: true,
}, [
  { status: 'completed', gatewayResult: 'SUCCESS', gatewayTransactionId: 'TXN-US-001', createdAt: new Date('2026-02-08') },
])

console.log('  2 links (1 reusable with 4 payments, 1 one-time completed)')

// ─── Fatima Hassan: Mix of EUR and PKR ───
console.log('\nSeeding Fatima Hassan — 2 links in different currencies...')

await createLinkWithPayments(fatima, {
  description: 'May 2026 — Noorani Qaida 5 Days/Week',
  amount: 80,
  currency: 'EUR',
  items: ['Noorani Qaida', '5 sessions/week', 'May 2026'],
  listType: 'numbered',
  expiresAfterPayment: true,
}, [
  { status: 'expired', gatewayResult: 'EXPIRED', createdAt: new Date('2026-05-01') },
  { status: 'completed', gatewayResult: 'SUCCESS', gatewayTransactionId: 'TXN-EU-001', createdAt: new Date('2026-05-03') },
])

await createLinkWithPayments(fatima, {
  description: 'June 2026 — Noorani Qaida 5 Days/Week',
  amount: 80,
  currency: 'EUR',
  items: ['Noorani Qaida', '5 sessions/week', 'June 2026'],
  listType: 'numbered',
  expiresAfterPayment: true,
}, [
  { status: 'pending', createdAt: new Date('2026-06-02') },
])

console.log('  2 links (1 completed after retry, 1 pending)')

console.log('\n✅ Seed complete!')
console.log('\nSummary:')
console.log('  Ahmed Khan  — 4 PKR links (3 completed = Rs. 42,000 total, 1 pending)')
console.log('  Sarah Ali   — 1 reusable GBP link (3 completed + 1 failed = £105) + 1 USD link ($50)')
console.log('  Fatima Hassan — 2 EUR links (1 completed after expired retry = €80, 1 pending)')

await mongoose.disconnect()
