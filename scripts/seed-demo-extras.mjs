// Supplementary demo seed — fills every model seedDemo.js does NOT cover, so no
// portal/admin page is blank in a client demo. Run AFTER seedDemo.js.
//
// Usage (from hidayah-backend/):
//   MONGODB_URI='<demo-uri>' node scripts/seed-demo-extras.mjs
//
// Idempotent: clears the models it owns, then reseeds.

import 'dotenv/config'
import mongoose from 'mongoose'
import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import Family from '../models/Family.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Enrollment from '../models/Enrollment.js'
import EmployeeOfMonth from '../models/EmployeeOfMonth.js'
import DemoTrial from '../models/DemoTrial.js'
import LeaveRequest from '../models/LeaveRequest.js'
import Advance from '../models/Advance.js'
import Badge from '../models/Badge.js'
import Expense from '../models/Expense.js'
import TutorChangeRequest from '../models/TutorChangeRequest.js'
import Plan from '../models/Plan.js'
import DiscountCode from '../models/DiscountCode.js'
import Payment from '../models/Payment.js'
import PaymentLink from '../models/PaymentLink.js'
import Subscriber from '../models/Subscriber.js'
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import BlogPost from '../models/BlogPost.js'
import ShiftConfig from '../models/ShiftConfig.js'
import FeePayment from '../models/FeePayment.js'
import StudentStatusHistory from '../models/StudentStatusHistory.js'
import WhatsappReminderLog from '../models/WhatsappReminderLog.js'

const pick = (a) => a[Math.floor(Math.random() * a.length)]
const rint = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d }
const monthsAgo = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); d.setDate(rint(1, 27)); return d }

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set')
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected:', mongoose.connection.host, '/', mongoose.connection.db.databaseName)
  if (/cluster0\.yzyvei2/.test(process.env.MONGODB_URI)) throw new Error('Refusing to seed the LIVE cluster')

  const students = await Student.find().lean()
  const tutors = await TutorProfile.find().lean()
  const families = await Family.find().lean()
  const users = await User.find().populate('roles').lean()
  if (!students.length || !tutors.length) throw new Error('Run seedDemo.js first (no students/tutors found)')

  const superAdmin = users.find(u => u.roles?.some(r => r.key === 'super_admin')) || users[0]
  const coord = users.find(u => u.roles?.some(r => r.key === 'coordinator')) || superAdmin
  const qci = users.find(u => u.roles?.some(r => r.key === 'qci')) || superAdmin
  const tutorUserByTutor = (t) => users.find(u => String(u.linkedTutorId) === String(t._id)) || superAdmin
  const now = new Date()
  const CUR = ['PKR', 'USD', 'GBP']
  const TRACKS = ['nazra', 'hifz', 'qaida', 'tajweed', 'tafseer', 'translation']

  // Wipe the models this script owns
  await Promise.all([
    Enrollment.deleteMany({}), EmployeeOfMonth.deleteMany({}), DemoTrial.deleteMany({}),
    LeaveRequest.deleteMany({}), Advance.deleteMany({}), Badge.deleteMany({}),
    Expense.deleteMany({}), TutorChangeRequest.deleteMany({}), Plan.deleteMany({}),
    DiscountCode.deleteMany({}), Payment.deleteMany({}), PaymentLink.deleteMany({}),
    Subscriber.deleteMany({}), StudentFeeRecord.deleteMany({}), BlogPost.deleteMany({}),
    ShiftConfig.deleteMany({}), FeePayment.deleteMany({}), StudentStatusHistory.deleteMany({}),
    WhatsappReminderLog.deleteMany({}),
  ])

  // ── Leads (Enrollment) ──
  const LEAD_NAMES = ['Ayesha Siddiqa', 'Bilal Ahmad', 'Fatima Noor', 'Hamza Tariq', 'Zainab Iqbal', 'Usman Farooq', 'Maryam Yousuf', 'Ibrahim Khan', 'Sana Malik', 'Yousaf Ali', 'Hafsa Rehman', 'Talha Javed', 'Amina Zia', 'Saad Anwar', 'Nida Ashraf']
  const leadStatus = ['new', 'new', 'contacted', 'contacted', 'enrolled', 'closed']
  const leads = await Enrollment.insertMany(LEAD_NAMES.map((name, i) => ({
    name, email: `${name.split(' ')[0].toLowerCase()}.lead${i}@gmail.com`,
    phone: `+9230${rint(10, 99)}${rint(1000000, 9999999)}`,
    message: pick(['Interested in Hifz classes for my son', 'Want a free trial for Nazra', 'Please share fee structure', 'Looking for weekend Quran classes']),
    source: pick(['hero_form', 'free_class', 'contact', 'manual']),
    status: leadStatus[i % leadStatus.length],
    referralSource: pick(['Google Ads', 'Facebook', 'Instagram', 'Friend/Family', 'YouTube', '']),
    demoTutorId: pick(tutors)._id,
    trialDate: i % 3 === 0 ? daysAgo(-rint(1, 6)) : undefined,
    trialStatus: pick(['pending', 'scheduled', 'passed', 'failed', '']),
    createdAt: daysAgo(rint(0, 40)),
  })))
  console.log(`Leads (enrollments): ${leads.length}`)

  // ── Demo trials ──
  const demoStatus = ['scheduled', 'scheduled', 'sign_up', 'failed', 'no_show', 'start_later']
  const demos = await DemoTrial.insertMany(LEAD_NAMES.slice(0, 12).map((name, i) => {
    const t = pick(tutors)
    return {
      date: daysAgo(rint(-5, 25)), time: pick(['20:00', '20:30', '21:00', '21:30', '22:00']),
      studentName: name, demoTutorId: t._id, demoTutor: `${t.name} (${t.tutorId})`,
      managerIds: [coord._id], source: pick(['Google Ads', 'Facebook', 'Instagram', 'Referral']),
      status: demoStatus[i % demoStatus.length], comment: pick(['Good response', 'Follow up next week', 'Parent will decide', '']),
      createdBy: coord._id, createdAt: daysAgo(rint(0, 30)),
    }
  }))
  console.log(`Demo trials: ${demos.length}`)

  // ── Awards (Employee of the Month) — unique per (year, month) ──
  const awards = []
  for (let k = 0; k < 6; k++) {
    const d = monthsAgo(k)
    awards.push({
      tutorId: tutors[k % tutors.length]._id, month: d.getMonth() + 1, year: d.getFullYear(),
      reason: pick(['Outstanding student results', 'Perfect attendance & punctuality', 'Excellent parent feedback', 'Most classes taught this month']),
      awardedBy: superAdmin._id, acknowledgedAt: k > 1 ? daysAgo(k * 20) : null,
    })
  }
  await EmployeeOfMonth.insertMany(awards)
  console.log(`Awards: ${awards.length}`)

  // ── Badges ──
  const BADGE_TYPES = ['quran_star', 'fast_learner', 'perfect_attendance', 'top_performer', 'consistency', 'best_recitation', 'memory_master', 'most_improved', 'class_leader', 'effort_award']
  const BADGE_TITLES = { quran_star: 'Quran Star', fast_learner: 'Fast Learner', perfect_attendance: 'Perfect Attendance', top_performer: 'Top Performer', consistency: 'Consistency Champion', best_recitation: 'Best Recitation', memory_master: 'Memory Master', most_improved: 'Most Improved', class_leader: 'Class Leader', effort_award: 'Effort Award' }
  const badgeStatus = ['approved', 'approved', 'approved', 'pending', 'rejected']
  const badges = await Badge.insertMany(Array.from({ length: 16 }, (_, i) => {
    const bt = BADGE_TYPES[i % BADGE_TYPES.length]
    const st = badgeStatus[i % badgeStatus.length]
    return {
      studentId: pick(students)._id, badgeType: bt, title: BADGE_TITLES[bt],
      description: 'Awarded for excellent progress this month.', status: st,
      submittedBy: pick(tutors) && tutorUserByTutor(pick(tutors))._id,
      approvedBy: st === 'approved' ? qci._id : undefined,
      approvedAt: st === 'approved' ? daysAgo(rint(1, 20)) : undefined,
      rejectionReason: st === 'rejected' ? 'Insufficient evidence — resubmit with details.' : '',
      createdAt: daysAgo(rint(0, 45)),
    }
  }))
  console.log(`Badges: ${badges.length}`)

  // ── Leave requests ──
  const leaveTypes = ['sick', 'casual', 'emergency', 'personal', 'other']
  const leaveStatus = ['pending', 'pending', 'approved', 'approved', 'rejected']
  const leaves = []
  for (let i = 0; i < 9; i++) {
    const t = tutors[i % tutors.length]
    const start = daysAgo(rint(-10, 20))
    const end = new Date(start); end.setDate(end.getDate() + rint(0, 3))
    const st = leaveStatus[i % leaveStatus.length]
    leaves.push({
      tutorId: t._id, requestedBy: tutorUserByTutor(t)._id, leaveType: leaveTypes[i % leaveTypes.length],
      startDate: start, endDate: end, reason: pick(['Fever and rest advised by doctor', 'Family function out of city', 'Personal emergency', 'Travelling for a few days']),
      status: st, reviewedBy: st !== 'pending' ? coord._id : undefined,
      reviewedAt: st !== 'pending' ? daysAgo(rint(1, 8)) : undefined,
      reviewNotes: st === 'rejected' ? 'Coverage not available for these dates.' : st === 'approved' ? 'Approved. Arrange substitute.' : '',
    })
  }
  await LeaveRequest.insertMany(leaves)
  console.log(`Leave requests: ${leaves.length}`)

  // ── Advances / loans ──
  const advances = []
  for (let i = 0; i < 6; i++) {
    const t = tutors[i % tutors.length]
    const total = rint(20, 60) * 1000
    const inst = Math.round(total / rint(3, 6))
    const repaid = i % 3 === 0 ? total : inst * rint(0, 2)
    const st = repaid >= total ? 'fully_paid' : (i % 4 === 0 ? 'requested' : 'active')
    const created = daysAgo(rint(10, 90))
    advances.push({
      tutorId: t._id, type: pick(['short_term', 'long_term']), totalAmount: total, currency: 'PKR',
      installmentAmount: inst, installmentFrequency: 'monthly', amountRepaid: repaid,
      remainingBalance: Math.max(0, total - repaid), status: st,
      reason: pick(['Medical expenses', 'Home repairs', 'Family event', 'Personal need']),
      startDate: created, approvedBy: st !== 'requested' ? superAdmin._id : undefined,
      requestedBy: tutorUserByTutor(t)._id, createdAt: created,
    })
  }
  await Advance.insertMany(advances)
  console.log(`Advances: ${advances.length}`)

  // ── Expenses & income ──
  const EXP = [
    ['Office rent — July', 'rent', 120000, 'expense'], ['Electricity bill', 'utilities', 18500, 'expense'],
    ['Internet & fibre', 'utilities', 9000, 'expense'], ['New headsets (10)', 'equipment', 35000, 'expense'],
    ['Zoom Pro subscription', 'software', 6500, 'expense'], ['Facebook Ads', 'marketing', 45000, 'expense'],
    ['Google Ads', 'marketing', 60000, 'expense'], ['Whiteboard markers & supplies', 'office_supplies', 4200, 'expense'],
    ['AC servicing', 'maintenance', 8000, 'expense'], ['Petty cash top-up', 'petty_cash', 10000, 'expense'],
    ['Course fee income', 'budget', 250000, 'income'], ['Registration fees', 'budget', 40000, 'income'],
  ]
  const expenses = await Expense.insertMany(Array.from({ length: 22 }, (_, i) => {
    const e = EXP[i % EXP.length]
    return { title: e[0], category: e[1], amount: e[2] + rint(-2000, 2000), currency: 'PKR', type: e[3], date: monthsAgo(i % 4), description: 'Recorded from monthly ledger.', createdBy: superAdmin._id }
  }))
  console.log(`Expenses/income: ${expenses.length}`)

  // ── Tutor change requests ──
  const tcrStatus = ['pending', 'pending', 'approved', 'rejected']
  const tcrs = []
  for (let i = 0; i < 6; i++) {
    const st = students[i * 3 % students.length]
    const from = pick(tutors), to = pick(tutors.filter(t => String(t._id) !== String(from._id)))
    const s = tcrStatus[i % tcrStatus.length]
    tcrs.push({
      studentId: st._id, track: pick(TRACKS), fromTutorId: from._id, toTutorId: to._id,
      reason: pick(['Timing clash with school', 'Requested a female tutor', 'Better track match', 'Parent request']),
      status: s, requestedBy: qci._id, requestedByRole: 'qci',
      reviewedBy: s !== 'pending' ? coord._id : undefined, reviewedAt: s !== 'pending' ? daysAgo(rint(1, 10)) : undefined,
      reviewNotes: s === 'approved' ? 'Reassigned.' : s === 'rejected' ? 'Current tutor retained.' : '',
    })
  }
  await TutorChangeRequest.insertMany(tcrs)
  console.log(`Tutor change requests: ${tcrs.length}`)

  // ── Plans ──
  await Plan.insertMany([
    { planId: '2-days', name: '2 Days / Week', sessions: '8 sessions/month', duration: '30 min each', price: 5000, prices: { PKR: 5000, USD: 30, EUR: 28, GBP: 25 }, features: ['2 classes per week', '1-on-1 tutor', 'Monthly report'], popular: false, active: true },
    { planId: '3-days', name: '3 Days / Week', sessions: '12 sessions/month', duration: '30 min each', price: 7000, prices: { PKR: 7000, USD: 40, EUR: 38, GBP: 34 }, features: ['3 classes per week', '1-on-1 tutor', 'Monthly report', 'Progress tracking'], popular: true, active: true },
    { planId: '5-days', name: '5 Days / Week', sessions: '20 sessions/month', duration: '30 min each', price: 10000, prices: { PKR: 10000, USD: 60, EUR: 56, GBP: 50 }, features: ['5 classes per week', '1-on-1 tutor', 'Weekly report', 'Priority scheduling'], popular: false, active: true },
  ])
  console.log('Plans: 3')

  // ── Discount codes ──
  await DiscountCode.insertMany([
    { code: 'WELCOME500', discountAmount: 500, currency: 'PKR', usageType: 'one_time', timesUsed: 3, isActive: true, description: 'New student welcome discount' },
    { code: 'RAMADAN10', discountAmount: 10, currency: 'USD', usageType: 'recurring', timesUsed: 7, isActive: true, description: 'Ramadan special' },
    { code: 'SIBLING1000', discountAmount: 1000, currency: 'PKR', usageType: 'recurring', timesUsed: 5, isActive: true, description: 'Sibling discount' },
    { code: 'SUMMER15', discountAmount: 15, currency: 'GBP', usageType: 'one_time', timesUsed: 0, isActive: true, description: 'Summer promo' },
    { code: 'EXPIRED5', discountAmount: 5, currency: 'USD', usageType: 'one_time', timesUsed: 12, isActive: false, description: 'Ended campaign' },
  ])
  console.log('Discount codes: 5')

  // ── Payments (revenue) ──
  const payStatus = ['completed', 'completed', 'completed', 'completed', 'pending', 'failed', 'refunded']
  const planNames = ['2 Days / Week', '3 Days / Week', '5 Days / Week']
  const payments = await Payment.insertMany(Array.from({ length: 30 }, (_, i) => {
    const s = students[i % students.length]
    const cur = pick(CUR)
    const amt = cur === 'PKR' ? pick([5000, 7000, 10000]) : pick([30, 40, 60])
    const st = payStatus[i % payStatus.length]
    return {
      studentName: s.name, studentEmail: `${(s.rollNo || 'stu').toLowerCase()}@hidaya.com`, plan: pick(planNames),
      amount: amt, currency: cur, paymentMethod: 'CARD', status: st,
      gatewayResult: st === 'completed' ? 'SUCCESS' : st === 'failed' ? 'FAILURE' : 'PENDING',
      invoiceNo: `INV-${2026}-${String(1000 + i)}`, student: s._id, originalAmount: amt,
      createdAt: daysAgo(rint(0, 120)),
    }
  }))
  console.log(`Payments: ${payments.length}`)

  // ── Payment links ──
  const links = await PaymentLink.insertMany(Array.from({ length: 10 }, (_, i) => {
    const s = students[i % students.length]
    const cur = pick(CUR)
    return {
      payeeName: s.name, payeeEmail: `${(s.rollNo || 'stu').toLowerCase()}@hidaya.com`,
      description: pick(['Monthly fee — July', 'Registration + first month', 'Quarterly fee', 'Books & materials']),
      amount: cur === 'PKR' ? pick([5000, 7000, 10000]) : pick([30, 40, 60]), currency: cur,
      status: pick(['active', 'active', 'completed']), student: s._id, items: ['Tuition fee'],
      createdAt: daysAgo(rint(0, 30)),
    }
  }))
  console.log(`Payment links: ${links.length}`)

  // ── Subscribers ──
  await Subscriber.insertMany(Array.from({ length: 24 }, (_, i) => ({
    email: `subscriber${i + 1}@example.com`, status: i % 8 === 0 ? 'unsubscribed' : 'active', createdAt: daysAgo(rint(0, 200)),
  })))
  console.log('Subscribers: 24')

  // ── Student fee records (fee management grid) — last 4 months for 24 students ──
  const feeDocs = []
  const feeStudents = students.slice(0, 24)
  const y = now.getFullYear()
  for (const s of feeStudents) {
    const fam = families.find(f => String(f._id) === String(s.familyId))
    const monthly = s.feeAmount || rint(4, 10) * 1000
    for (let k = 0; k < 4; k++) {
      const d = monthsAgo(k)
      const status = k === 0 ? pick(['pending', 'partial', 'received']) : 'received'
      const amountPaid = status === 'received' ? monthly : status === 'partial' ? Math.round(monthly / 2) : 0
      feeDocs.push({
        studentId: s._id, familyId: fam?._id, year: d.getFullYear(), month: d.getMonth() + 1,
        amount: monthly, amountPaid, currency: s.feeCurrency || 'PKR', status,
        method: status === 'pending' ? '' : pick(['Bank transfer', 'JazzCash', 'Card']),
        paidAt: status === 'received' ? d : undefined, recordedBy: superAdmin._id,
      })
    }
  }
  // guard against the unique (studentId,year,month) index
  await StudentFeeRecord.insertMany(feeDocs, { ordered: false }).catch(() => {})
  console.log(`Student fee records: ${feeDocs.length}`)

  // ── Blog posts ──
  await BlogPost.insertMany([
    { slug: 'benefits-of-learning-quran-online', title: 'The Benefits of Learning Quran Online', excerpt: 'How online Quran classes make consistent learning possible for busy families.', content: [{ heading: 'Flexibility', text: 'Learn from anywhere at a time that suits your family.' }, { heading: '1-on-1 Attention', text: 'Every student gets a dedicated tutor.' }], author: 'Hidaya Online', published: true },
    { slug: 'how-to-start-hifz-journey', title: 'How to Start Your Hifz Journey', excerpt: 'A practical guide to beginning Quran memorization.', content: [{ heading: 'Consistency', text: 'Daily revision is the key to retention.' }], author: 'Hidaya Online', published: true },
    { slug: 'tajweed-for-beginners', title: 'Tajweed for Beginners', excerpt: 'Understand the basics of correct Quran recitation.', content: [{ heading: 'Makharij', text: 'Learn the articulation points of each letter.' }], author: 'Hidaya Online', published: true },
    { slug: 'choosing-the-right-class-plan', title: 'Choosing the Right Class Plan', excerpt: 'Which weekly plan fits your child best?', content: [{ heading: 'Start small', text: 'Begin with 2–3 days a week and scale up.' }], author: 'Hidaya Online', published: true },
    { slug: 'ramadan-learning-schedule', title: 'Building a Ramadan Learning Schedule', excerpt: 'Keep momentum during the blessed month.', content: [{ heading: 'Plan ahead', text: 'Adjust class times around fasting and prayers.' }], author: 'Hidaya Online', published: false },
  ])
  console.log('Blog posts: 5')

  // ── Shift config (night shift, for salary shift page) ──
  await ShiftConfig.create({
    key: 'default', defaultShiftStart: '20:00', defaultShiftEnd: '23:30', overtimeThresholdMinutes: 15,
    bonusRules: { fullAttendanceBonus: 3000, onTimeBonus: 1000, extraHoursRate: 200, extraClassBonus: 300 },
    updatedBy: superAdmin._id,
  })
  console.log('Shift config: 1')

  // ── Fee payments (individual receipts, allocated to a student's month) ──
  const feePayments = []
  for (let i = 0; i < 16; i++) {
    const s = feeStudents[i % feeStudents.length]
    const d = monthsAgo(i % 4)
    const amt = s.fee || rint(4, 10) * 1000
    feePayments.push({
      amount: amt, currency: 'PKR', method: pick(['bank_transfer', 'cash', 'jazzcash', 'easypaisa', 'card']),
      reference: `TXN${rint(100000, 999999)}`, payerName: s.name,
      familyId: families.find(f => String(f._id) === String(s.familyId))?._id,
      paidAt: d, allocations: [{ studentId: s._id, year: d.getFullYear(), month: d.getMonth() + 1, amount: amt }],
      note: 'Monthly fee received.', recordedBy: superAdmin._id,
    })
  }
  await FeePayment.insertMany(feePayments)
  console.log(`Fee payments: ${feePayments.length}`)

  // ── Student status history ──
  const statusHist = []
  for (let i = 0; i < 14; i++) {
    const s = students[i % students.length]
    statusHist.push({
      studentId: s._id, status: pick(['active', 'active', 'leave', 'pending']),
      effectiveDate: daysAgo(rint(5, 120)), comment: pick(['Enrolled and active', 'On short leave (travel)', 'Resumed classes', 'Awaiting first payment']),
      changedBy: coord._id,
    })
  }
  await StudentStatusHistory.insertMany(statusHist)
  console.log(`Student status history: ${statusHist.length}`)

  // ── WhatsApp reminder logs (unique per student+date) ──
  const waLogs = students.slice(0, 18).map((s, i) => {
    const t = tutors[i % tutors.length]
    const dt = daysAgo(rint(0, 20)); dt.setHours(9 + (i % 6), 0, 0, 0)
    return { studentId: s._id, tutorId: t._id, sentDate: dt, sentBy: coord._id }
  })
  await WhatsappReminderLog.insertMany(waLogs, { ordered: false }).catch(() => {})
  console.log(`WhatsApp reminder logs: ${waLogs.length}`)

  console.log('\nExtras seed complete ✅')
  await mongoose.disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
