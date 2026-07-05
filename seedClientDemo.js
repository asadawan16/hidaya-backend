/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║       HIDAYA PORTAL — CLIENT DEMO SEED (Minimal)         ║
 * ║                                                           ║
 * ║  Clean, minimal data for a live client demo.              ║
 * ║  - 1 tutor (Ustaz Hamza) with 3 students assigned        ║
 * ║  - 1 class per student per day, 30 min each              ║
 * ║  - Today's session at 10:00 PM for the live demo         ║
 * ║  - Past sessions with lesson entries for history          ║
 * ║  - All accounts use password: Demo@123                    ║
 * ║                                                           ║
 * ║  Usage:  node seedClientDemo.js                           ║
 * ╚═══════════════════════════════════════════════════════════╝
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import Role from './models/Role.js'
import User from './models/User.js'
import Student from './models/Student.js'
import TutorProfile from './models/TutorProfile.js'
import StaffProfile from './models/StaffProfile.js'
import Family from './models/Family.js'
import StudentRelationship from './models/StudentRelationship.js'
import AdmissionApplication from './models/AdmissionApplication.js'
import ClassSlot from './models/ClassSlot.js'
import ClassSession from './models/ClassSession.js'
import TutorAttendance from './models/TutorAttendance.js'
import LessonEntry from './models/LessonEntry.js'
import PermanentLesson from './models/PermanentLesson.js'
import CurriculumItem from './models/CurriculumItem.js'
import Assignment from './models/Assignment.js'
import AssessmentTemplate from './models/AssessmentTemplate.js'
import Assessment from './models/Assessment.js'
import Notice from './models/Notice.js'
import Complaint from './models/Complaint.js'
import Invoice from './models/Invoice.js'
import SalaryRecord from './models/SalaryRecord.js'
import ChatThread from './models/ChatThread.js'
import Message from './models/Message.js'
import Notification from './models/Notification.js'

import { DEFAULT_ROLE_PERMISSIONS } from './config/permissions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PASSWORD = 'Demo@123'

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(8, 0, 0, 0)
  return d
}

function addMinutes(time, mins) {
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + mins
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to MongoDB\n')

  // ── WIPE EVERYTHING ──
  console.log('Clearing all portal data...')
  await Promise.all([
    User.deleteMany({}), Student.deleteMany({}), TutorProfile.deleteMany({}),
    StaffProfile.deleteMany({}), Family.deleteMany({}), StudentRelationship.deleteMany({}),
    AdmissionApplication.deleteMany({}), ClassSlot.deleteMany({}), ClassSession.deleteMany({}),
    TutorAttendance.deleteMany({}), LessonEntry.deleteMany({}), PermanentLesson.deleteMany({}),
    CurriculumItem.deleteMany({}), Assignment.deleteMany({}), AssessmentTemplate.deleteMany({}),
    Assessment.deleteMany({}), Notice.deleteMany({}), Complaint.deleteMany({}),
    Invoice.deleteMany({}), SalaryRecord.deleteMany({}), ChatThread.deleteMany({}),
    Message.deleteMany({}), Notification.deleteMany({}), Role.deleteMany({}),
  ])
  console.log('   Done.\n')

  // ══════════════════════════════════════════════════════
  // 1. ROLES
  // ══════════════════════════════════════════════════════
  console.log('1. Roles...')
  const ROLE_DEFS = [
    { key: 'super_admin', name: 'Super Admin', system: true },
    { key: 'admin', name: 'Admin', system: true },
    { key: 'principal', name: 'Principal' },
    { key: 'coordinator', name: 'Coordinator' },
    { key: 'qci', name: 'Quality Control Inspector' },
    { key: 'qcm', name: 'Quality Control Manager' },
    { key: 'tutor', name: 'Tutor' },
    { key: 'student', name: 'Student' },
  ]
  const roles = {}
  for (const def of ROLE_DEFS) {
    const perms = DEFAULT_ROLE_PERMISSIONS[def.key] || []
    const r = await Role.findOneAndUpdate(
      { key: def.key },
      { name: def.name, permissions: perms, system: !!def.system },
      { upsert: true, new: true }
    )
    roles[def.key] = r._id
    console.log(`   ${def.key} (${perms.length} perms)`)
  }

  // ══════════════════════════════════════════════════════
  // 2. CURRICULUM (small set)
  // ══════════════════════════════════════════════════════
  console.log('\n2. Curriculum...')
  const curricItems = []
  for (let i = 1; i <= 30; i++) {
    curricItems.push({ track: 'qaida', type: 'page', label: `Qaida Page ${i}`, order: i, meta: { pageNumber: i } })
  }
  const surahNames = ['Al-Fatiha', 'Al-Baqarah', 'Aal-e-Imran', 'An-Nisa', 'Al-Maidah']
  for (let i = 0; i < surahNames.length; i++) {
    curricItems.push({ track: 'quran', type: 'surah', label: surahNames[i], order: i + 1, meta: { surahNumber: i + 1 } })
  }
  for (let i = 1; i <= 30; i++) {
    curricItems.push({ track: 'hifz', type: 'para', label: `Para ${i}`, order: i, meta: { paraNumber: i } })
  }
  const savedCurric = await CurriculumItem.insertMany(curricItems)
  console.log(`   ${savedCurric.length} curriculum items`)

  // ══════════════════════════════════════════════════════
  // 3. USERS — Admin staff (minimal)
  // ══════════════════════════════════════════════════════
  console.log('\n3. Users...')

  async function createUser(email, displayName, roleKeys, extra = {}) {
    const user = new User({
      email, password: PASSWORD, displayName,
      roles: roleKeys.map(k => roles[k]),
      status: 'active',
      ...extra,
    })
    await user.save()
    console.log(`   ${email} [${roleKeys.join(', ')}]`)
    return user
  }

  const superAdmin = await createUser('superadmin@hidaya.com', 'Muhammad Owais', ['super_admin'])
  const adminUser  = await createUser('admin@hidaya.com', 'Fatima Zahra', ['admin'])
  const coord      = await createUser('coordinator@hidaya.com', 'Hira Malik', ['coordinator'])
  const qci        = await createUser('qci@hidaya.com', 'Ustaz Imran Siddiqui', ['qci'])

  // Staff profiles
  for (const u of [superAdmin, adminUser, coord, qci]) {
    await StaffProfile.findOneAndUpdate(
      { userId: u._id },
      { userId: u._id, title: 'Staff', department: 'Administration' },
      { upsert: true }
    )
  }

  // ══════════════════════════════════════════════════════
  // 4. TUTOR — One tutor assigned to all 3 students
  // ══════════════════════════════════════════════════════
  console.log('\n4. Tutor...')
  const tutorUser = await createUser('tutor@hidaya.com', 'Ustaz Hamza Ali', ['tutor'])

  // Build shift windows for every day Mon-Sat, 9 AM to 11 PM
  const shiftWindows = []
  for (let d = 1; d <= 6; d++) {
    shiftWindows.push({ dayOfWeek: d, startTime: '09:00', endTime: '23:00', timezone: 'Asia/Karachi' })
  }
  // Also Sunday for the demo (in case today is Sunday)
  shiftWindows.push({ dayOfWeek: 0, startTime: '09:00', endTime: '23:00', timezone: 'Asia/Karachi' })

  const tutor = await TutorProfile.create({
    tutorId: 'TUT-001',
    userId: tutorUser._id,
    name: 'Ustaz Hamza Ali',
    email: 'tutor@hidaya.com',
    phone: '+923001234567',
    skillLevel: 'expert',
    roomNo: 'R-1',
    meetLink: 'https://meet.google.com/abc-demo-001',
    shiftWindows,
    status: 'active',
    salary: { baseAmount: 25000, currency: 'PKR' },
    subjects: ['qaida', 'nazra', 'hifz'],
  })
  await User.updateOne({ _id: tutorUser._id }, { linkedTutorId: tutor._id })
  console.log(`   Tutor: ${tutor.name} (${tutor.tutorId})`)

  // ══════════════════════════════════════════════════════
  // 5. STUDENTS — 3 students, each with a portal account
  // ══════════════════════════════════════════════════════
  console.log('\n5. Students...')

  const studentData = [
    { name: 'Ahmed Khan',   email: 'ahmed@hidaya.com',   rollNo: 'HQ-0001', course: 'qaida',  country: 'Pakistan',       tz: 'Asia/Karachi',    father: 'Abdul Rashid Khan',   fee: 5000,  currency: 'PKR' },
    { name: 'Maryam Ali',   email: 'maryam@hidaya.com',  rollNo: 'HQ-0002', course: 'nazra',  country: 'United Kingdom', tz: 'Europe/London',   father: 'Muhammad Tariq Ali',  fee: 30,    currency: 'GBP' },
    { name: 'Yusuf Hassan', email: 'yusuf@hidaya.com',   rollNo: 'HQ-0003', course: 'hifz',   country: 'United States',  tz: 'America/New_York', father: 'Zahid Hussain Hassan', fee: 40,    currency: 'USD' },
  ]

  const students = []
  const studentUsers = []

  for (const sd of studentData) {
    // Create student record first
    const student = await Student.create({
      rollNo: sd.rollNo,
      name: sd.name,
      parentsName: sd.father,
      dob: new Date(2014, 3, 15),
      joiningDate: daysAgo(90),
      country: sd.country,
      timezone: sd.tz,
      guardians: [
        { relation: 'father', name: sd.father, phone: '+923001111111', email: `parent.${sd.email}`, isWhatsappRecipient: true },
      ],
      whatsappNumber: '+923001111111',
      courseLabels: [sd.course],
      placementLevel: 'qaida_basic',
      sect: 'sunni',
      billing: { fee: sd.fee, amount: sd.fee, currency: sd.currency, whoPays: 'father', cycle: 'monthly', status: 'paid' },
      status: 'active',
    })

    // Create user account and link to student
    const user = await createUser(sd.email, sd.name, ['student'], { linkedStudentId: student._id })

    // Link student back to user
    await Student.updateOne({ _id: student._id }, { userId: user._id })

    students.push(student)
    studentUsers.push(user)
    console.log(`   Student: ${sd.name} (${sd.rollNo}) → ${sd.email}`)
  }

  // ══════════════════════════════════════════════════════
  // 6. ASSIGNMENTS — Tutor assigned to all 3 students
  // ══════════════════════════════════════════════════════
  console.log('\n6. Assignments...')
  for (const st of students) {
    await Assignment.create({
      studentId: st._id,
      tutorId: tutor._id,
      track: st.courseLabels[0],
      startDate: st.joiningDate,
      assignedBy: coord._id,
    })
    console.log(`   ${tutor.name} → ${st.name} (${st.courseLabels[0]})`)
  }

  // ══════════════════════════════════════════════════════
  // 7. CLASS SLOTS — 1 slot per student per day
  //    Each student gets a different time to avoid overlap
  //    Today's classes scheduled at 10:00 PM, 10:30 PM, 11:00 PM
  // ══════════════════════════════════════════════════════
  console.log('\n7. Class Slots...')
  const today = new Date()
  const todayDow = today.getDay() // 0=Sun, 6=Sat

  // Each student: one class per day on today's day-of-week
  // Stagger times: 22:00, 22:00, 22:00 (but different days for variety)
  // For the demo: all 3 students have class TODAY
  const slotTimes = ['22:00', '22:30', '23:00'] // 10:00 PM, 10:30 PM, 11:00 PM

  const slots = []
  for (let i = 0; i < students.length; i++) {
    const st = students[i]
    // Create slot for today's day of week
    const slot = await ClassSlot.create({
      studentId: st._id,
      tutorId: tutor._id,
      track: st.courseLabels[0],
      dayOfWeek: todayDow,
      startTime: slotTimes[i],
      durationMinutes: 30,
      meetLink: tutor.meetLink,
      active: true,
    })
    slots.push(slot)
    console.log(`   ${st.name} — ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][todayDow]} ${slotTimes[i]} (30 min)`)

    // Also create a slot for one other day so weekly schedule shows more
    const otherDow = (todayDow + 2) % 7
    await ClassSlot.create({
      studentId: st._id,
      tutorId: tutor._id,
      track: st.courseLabels[0],
      dayOfWeek: otherDow,
      startTime: slotTimes[i],
      durationMinutes: 30,
      meetLink: tutor.meetLink,
      active: true,
    })
    console.log(`   ${st.name} — ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][otherDow]} ${slotTimes[i]} (30 min)`)
  }

  // ══════════════════════════════════════════════════════
  // 8. CLASS SESSIONS — Past + Today
  // ══════════════════════════════════════════════════════
  console.log('\n8. Sessions...')
  const sessions = []

  const qaidaCurric = savedCurric.filter(c => c.track === 'qaida')
  const quranCurric = savedCurric.filter(c => c.track === 'quran')
  const hifzCurric  = savedCurric.filter(c => c.track === 'hifz')
  const curricPools = [qaidaCurric, quranCurric, hifzCurric]

  for (let i = 0; i < students.length; i++) {
    const st = students[i]
    const slot = slots[i]
    const startTime = slotTimes[i]
    const endTime = addMinutes(startTime, 30)

    // Past 14 days: generate completed sessions (every 2-3 days to keep it clean)
    for (const dAgo of [14, 12, 10, 7, 5, 3]) {
      const date = daysAgo(dAgo)
      const sess = await ClassSession.create({
        slotId: slot._id,
        studentId: st._id,
        tutorId: tutor._id,
        date,
        scheduledStart: startTime,
        scheduledEnd: endTime,
        status: 'completed',
        attendance: 'on_time',
        computedDuration: 30,
        notes: '',
      })
      sessions.push(sess)

      // Lesson entry for completed session
      const pool = curricPools[i]
      const item = pool[dAgo % pool.length]
      await LessonEntry.create({
        sessionId: sess._id,
        studentId: st._id,
        tutorId: tutor._id,
        date,
        classStart: startTime,
        classEnd: endTime,
        kind: 'daily',
        items: [{ curriculumItemId: item._id, fromUnit: 'Line 1', toUnit: `Line ${5 + (dAgo % 5)}` }],
        notes: ['Good progress', 'Excellent recitation', 'Needs revision on makharij', 'Very attentive today', 'Revised previous lesson', 'Improving steadily'][dAgo % 6],
      })
    }

    // TODAY's session — SCHEDULED (this is the one for the 10 PM demo)
    const todayDate = new Date()
    todayDate.setHours(0, 0, 0, 0)
    const todaySession = await ClassSession.create({
      slotId: slot._id,
      studentId: st._id,
      tutorId: tutor._id,
      date: todayDate,
      scheduledStart: startTime,
      scheduledEnd: endTime,
      status: 'scheduled',
      attendance: '',
      notes: '',
    })
    sessions.push(todaySession)
    console.log(`   ${st.name} — TODAY ${startTime}-${endTime} [scheduled]`)
  }
  console.log(`   + ${students.length * 6} past completed sessions with lesson entries`)

  // ══════════════════════════════════════════════════════
  // 9. TUTOR ATTENDANCE (last 7 days)
  // ══════════════════════════════════════════════════════
  console.log('\n9. Tutor Attendance...')
  for (let d = 7; d >= 1; d--) {
    const date = daysAgo(d)
    if (date.getDay() === 0) continue
    await TutorAttendance.create({
      tutorId: tutor._id,
      date,
      checkInAt: new Date(date.getTime() + 9 * 3600000),
      checkOutAt: new Date(date.getTime() + 17 * 3600000),
      totalHours: 8,
      status: 'present',
    })
  }
  console.log('   7 days of attendance')

  // ══════════════════════════════════════════════════════
  // 10. INVOICES (1 per student — paid)
  // ══════════════════════════════════════════════════════
  console.log('\n10. Invoices...')
  for (let i = 0; i < students.length; i++) {
    const st = students[i]
    await Invoice.create({
      invoiceNo: `INV-2026-${String(i + 1).padStart(4, '0')}`,
      studentId: st._id,
      items: [{ description: `Monthly Tuition — ${st.courseLabels[0]}`, amount: st.billing.fee, quantity: 1 }],
      amount: st.billing.fee,
      currency: st.billing.currency,
      dueDate: daysAgo(-15),
      status: 'paid',
      paidAmount: st.billing.fee,
      createdBy: adminUser._id,
    })
    console.log(`   ${st.name} — ${st.billing.currency} ${st.billing.fee} (paid)`)
  }

  // ══════════════════════════════════════════════════════
  // 11. NOTICES (1 active notice)
  // ══════════════════════════════════════════════════════
  console.log('\n11. Notices...')
  await Notice.create({
    type: 'teacher',
    targetTutorId: tutor._id,
    message: 'Please ensure all lesson entries are submitted by end of each class session.',
    severity: 'info',
    active: true,
    createdBy: coord._id,
  })
  console.log('   1 notice for tutor')

  // ══════════════════════════════════════════════════════
  // 12. CHAT — 1 channel with a few messages
  // ══════════════════════════════════════════════════════
  console.log('\n12. Chat...')
  const allStaffIds = [superAdmin, adminUser, coord, qci, tutorUser].map(u => u._id)
  const channel = await ChatThread.create({
    type: 'channel',
    name: 'General',
    description: 'General discussion for all staff',
    label: 'general',
    createdBy: adminUser._id,
    participants: allStaffIds,
    lastMessageAt: new Date(),
  })
  const chatMsgs = [
    { sender: adminUser._id, body: 'Assalamu Alaikum everyone! Welcome to Hidaya Portal.' },
    { sender: tutorUser._id, body: 'Wa Alaikum Assalam! JazakAllah for setting this up.' },
    { sender: coord._id, body: 'Reminder: Please submit lesson entries after each class.' },
  ]
  for (const msg of chatMsgs) {
    await Message.create({ threadId: channel._id, senderId: msg.sender, body: msg.body, format: 'plain' })
  }
  console.log('   1 channel, 3 messages')

  // ══════════════════════════════════════════════════════
  // CREDENTIALS FILE
  // ══════════════════════════════════════════════════════
  const credLines = [
    '# Hidaya Portal — Client Demo Credentials',
    '',
    `> All accounts use password: \`${PASSWORD}\``,
    `> Generated: ${new Date().toISOString().split('T')[0]}`,
    '',
    '## Staff Accounts',
    '',
    '| Role | Email | Name |',
    '|------|-------|------|',
    `| Super Admin | superadmin@hidaya.com | Muhammad Owais |`,
    `| Admin | admin@hidaya.com | Fatima Zahra |`,
    `| Coordinator | coordinator@hidaya.com | Hira Malik |`,
    `| QCI | qci@hidaya.com | Ustaz Imran Siddiqui |`,
    '',
    '## Tutor Account',
    '',
    '| Email | Name | Students |',
    '|-------|------|----------|',
    `| tutor@hidaya.com | Ustaz Hamza Ali | Ahmed, Maryam, Yusuf |`,
    '',
    '## Student Accounts',
    '',
    '| Email | Name | Roll No | Course | Class Time (Today) |',
    '|-------|------|---------|--------|---------------------|',
    `| ahmed@hidaya.com | Ahmed Khan | HQ-0001 | Qaida | 10:00 PM |`,
    `| maryam@hidaya.com | Maryam Ali | HQ-0002 | Nazra | 10:30 PM |`,
    `| yusuf@hidaya.com | Yusuf Hassan | HQ-0003 | Hifz | 11:00 PM |`,
    '',
    '## Demo Flow',
    '',
    '1. Login as **tutor@hidaya.com** → See 3 assigned students on Schedule page',
    '2. At 10:00 PM, start Ahmed\'s session → Complete it → Log lesson entry',
    '3. Login as **ahmed@hidaya.com** → My Classes shows today\'s session',
    '4. Login as **admin@hidaya.com** → Full dashboard with schedule overview',
    '',
  ]

  fs.writeFileSync(path.join(__dirname, 'DEMO_CREDENTIALS.md'), credLines.join('\n'))
  console.log('\n   Written to DEMO_CREDENTIALS.md')

  // ══════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(52))
  console.log('  CLIENT DEMO SEED COMPLETE')
  console.log('='.repeat(52))
  console.log(`  Roles:           ${await Role.countDocuments()}`)
  console.log(`  Users:           ${await User.countDocuments()}`)
  console.log(`  Students:        ${await Student.countDocuments()}`)
  console.log(`  Tutor:           ${await TutorProfile.countDocuments()}`)
  console.log(`  Assignments:     ${await Assignment.countDocuments()}`)
  console.log(`  Class Slots:     ${await ClassSlot.countDocuments()}`)
  console.log(`  Class Sessions:  ${await ClassSession.countDocuments()}`)
  console.log(`  Lesson Entries:  ${await LessonEntry.countDocuments()}`)
  console.log(`  Curriculum:      ${await CurriculumItem.countDocuments()}`)
  console.log(`  Invoices:        ${await Invoice.countDocuments()}`)
  console.log('='.repeat(52))
  console.log(`\n  Password: ${PASSWORD}`)
  console.log(`  Today's demo sessions: 10:00 PM / 10:30 PM / 11:00 PM`)
  console.log('')

  await mongoose.disconnect()
  console.log('Done.')
}

seed().catch(err => {
  console.error('\nSeed failed:', err)
  process.exit(1)
})
