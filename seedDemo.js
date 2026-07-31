/**
 * ╔════════════════════════════════════════════════════════════╗
 * ║          HIDAYA PORTAL — COMPREHENSIVE DEMO SEED          ║
 * ║                                                            ║
 * ║  Floods the database with realistic demo data across ALL   ║
 * ║  models so every portal feature is populated for a client  ║
 * ║  demo. Credentials are written to DEMO_CREDENTIALS.md.    ║
 * ║                                                            ║
 * ║  Usage:  node seedDemo.js                                  ║
 * ║  Reset:  node seedDemo.js --reset  (wipes portal data)    ║
 * ╚════════════════════════════════════════════════════════════╝
 */

import 'dotenv/config'
import mongoose from 'mongoose'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Models
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
import SalaryIncrement from './models/SalaryIncrement.js'
import Certificate from './models/Certificate.js'
import ChatThread from './models/ChatThread.js'
import Message from './models/Message.js'
import Notification from './models/Notification.js'

import { DEFAULT_ROLE_PERMISSIONS } from './config/permissions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESET = process.argv.includes('--reset')
const PASSWORD = 'Demo@123'

// ─── Helpers ─────────────────────────────────────────────

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(8, 0, 0, 0); return d }
function monthsAgo(n) { const d = new Date(); d.setMonth(d.getMonth() - n); d.setDate(Math.floor(Math.random() * 20) + 1); return d }
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function randomBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function padTime(h, m) { return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
function randomTime(startH = 8, endH = 20) {
  const h = randomBetween(startH, endH)
  const m = randomFrom([0, 15, 30, 45])
  return padTime(h, m)
}
function addMinutes(time, mins) {
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + mins
  return padTime(Math.floor(total / 60) % 24, total % 60)
}

const TRACKS = ['nazra', 'hifz', 'tafseer', 'tajweed', 'translation', 'qaida']
const COUNTRIES = ['Pakistan', 'United Kingdom', 'United States', 'Canada', 'Australia', 'Saudi Arabia', 'UAE', 'Germany', 'France', 'South Africa']
const TIMEZONES = ['Asia/Karachi', 'Europe/London', 'America/New_York', 'America/Toronto', 'Australia/Sydney', 'Asia/Riyadh', 'Asia/Dubai', 'Europe/Berlin', 'Europe/Paris', 'Africa/Johannesburg']
const SECTS = ['sunni', 'shia', 'ahle_hadith']
const PLACEMENT = ['beginning', 'qaida_basic', 'qaida_weak', 'quran_good', 'quran_weak', 'quran_forgot']

// ─── Realistic Names ─────────────────────────────────────

const MALE_FIRST = ['Ahmed', 'Muhammad', 'Ibrahim', 'Yusuf', 'Omar', 'Ali', 'Hassan', 'Hamza', 'Bilal', 'Khalid', 'Zain', 'Usman', 'Talha', 'Adnan', 'Imran', 'Fahad', 'Saad', 'Rizwan', 'Junaid', 'Saqib', 'Noman', 'Farhan', 'Aqib', 'Arslan', 'Asad']
const FEMALE_FIRST = ['Fatima', 'Aisha', 'Maryam', 'Khadija', 'Zainab', 'Sara', 'Hira', 'Hafsa', 'Noor', 'Sumaya', 'Amina', 'Rabia', 'Sana', 'Madiha', 'Iqra', 'Bushra', 'Farah', 'Laiba', 'Ayesha', 'Asma']
const LAST_NAMES = ['Khan', 'Ahmed', 'Ali', 'Hassan', 'Shah', 'Malik', 'Hussain', 'Qureshi', 'Siddiqui', 'Mirza', 'Rana', 'Bukhari', 'Raza', 'Rehman', 'Chaudhry', 'Abbasi', 'Ansari', 'Sheikh', 'Akhtar', 'Nawaz']
const FATHER_NAMES = ['Muhammad Arif', 'Abdul Rashid', 'Muhammad Tariq', 'Zahid Hussain', 'Shahid Mehmood', 'Khalid Mehmood', 'Muhammad Irfan', 'Sajid Ali', 'Anwar Hussain', 'Ashfaq Ahmed', 'Muhammad Akram', 'Riaz Ahmed', 'Nadeem Ahmed', 'Kamran Ali', 'Waqar Ahmed']

let nameIdx = 0
function nextStudentName() {
  const pool = [...MALE_FIRST, ...FEMALE_FIRST]
  const first = pool[nameIdx % pool.length]
  const last = LAST_NAMES[nameIdx % LAST_NAMES.length]
  nameIdx++
  return `${first} ${last}`
}

function tutorName(i) {
  const firsts = ['Ustaz Hamza', 'Ustaz Bilal', 'Ustaza Hafsa', 'Ustaz Yusuf', 'Ustaza Maryam', 'Ustaz Khalid', 'Ustaza Noor', 'Ustaz Adnan', 'Ustaza Fatima', 'Ustaz Saad', 'Ustaza Khadija', 'Ustaz Farhan']
  return `${firsts[i % firsts.length]} ${LAST_NAMES[(i + 3) % LAST_NAMES.length]}`
}

// ═══════════════════════════════════════════════════════════
//  MAIN SEED
// ═══════════════════════════════════════════════════════════

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to MongoDB\n')

  if (RESET) {
    console.log('🗑️  Resetting portal data...')
    await Promise.all([
      User.deleteMany({}), Student.deleteMany({}), TutorProfile.deleteMany({}),
      StaffProfile.deleteMany({}), Family.deleteMany({}), StudentRelationship.deleteMany({}),
      AdmissionApplication.deleteMany({}), ClassSlot.deleteMany({}), ClassSession.deleteMany({}),
      TutorAttendance.deleteMany({}), LessonEntry.deleteMany({}), PermanentLesson.deleteMany({}),
      CurriculumItem.deleteMany({}), Assignment.deleteMany({}), AssessmentTemplate.deleteMany({}),
      Assessment.deleteMany({}), Notice.deleteMany({}), Complaint.deleteMany({}),
      Invoice.deleteMany({}), SalaryRecord.deleteMany({}), SalaryIncrement.deleteMany({}),
      Certificate.deleteMany({}), ChatThread.deleteMany({}),
      Message.deleteMany({}), Notification.deleteMany({}), Role.deleteMany({}),
    ])
    console.log('   All portal collections cleared.\n')
  }

  // ──────────────────────────────────────
  // 1. ROLES
  // ──────────────────────────────────────
  console.log('1. Seeding Roles...')
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

  // ──────────────────────────────────────
  // 2. CURRICULUM
  // ──────────────────────────────────────
  console.log('\n2. Seeding Curriculum...')
  const curricItems = []

  // Qaida pages
  for (let i = 1; i <= 30; i++) {
    curricItems.push({ track: 'qaida', type: 'page', label: `Qaida Page ${i}`, order: i, meta: { pageNumber: i } })
  }
  // Quran surahs (first 20)
  const surahNames = ['Al-Fatiha', 'Al-Baqarah', 'Aal-e-Imran', 'An-Nisa', 'Al-Maidah', 'Al-An\'am', 'Al-A\'raf', 'Al-Anfal', 'At-Tawbah', 'Yunus', 'Hud', 'Yusuf', 'Ar-Ra\'d', 'Ibrahim', 'Al-Hijr', 'An-Nahl', 'Al-Isra', 'Al-Kahf', 'Maryam', 'Ta-Ha']
  for (let i = 0; i < surahNames.length; i++) {
    curricItems.push({ track: 'quran', type: 'surah', label: surahNames[i], order: i + 1, meta: { surahNumber: i + 1 } })
  }
  // Hifz paras
  for (let i = 1; i <= 30; i++) {
    curricItems.push({ track: 'hifz', type: 'para', label: `Para ${i}`, order: i, meta: { paraNumber: i } })
  }
  // Kalimas
  const kalimas = ['Kalima Tayyaba', 'Kalima Shahadat', 'Kalima Tamjeed', 'Kalima Tauheed', 'Kalima Astaghfar', 'Kalima Radde Kufr']
  for (let i = 0; i < kalimas.length; i++) {
    curricItems.push({ track: 'kalima', type: 'kalima', label: kalimas[i], order: i + 1 })
  }
  // Duas
  const duas = ['Dua Before Eating', 'Dua After Eating', 'Dua Before Sleeping', 'Dua After Waking Up', 'Dua Entering Masjid', 'Dua Leaving Masjid', 'Dua for Parents', 'Dua for Guidance', 'Dua Before Travel', 'Dua After Travel']
  for (let i = 0; i < duas.length; i++) {
    curricItems.push({ track: 'dua', type: 'dua', label: duas[i], order: i + 1 })
  }
  // Namaz components
  const namazParts = ['Wudu Steps', 'Niyyah', 'Takbeer', 'Qiyam (Standing)', 'Ruku', 'Sajdah', 'Tashahhud', 'Durood', 'Dua after Tashahhud', 'Salam', 'Fajr Method', 'Zuhr Method', 'Asr Method', 'Maghrib Method', 'Isha Method', 'Witr Method']
  for (let i = 0; i < namazParts.length; i++) {
    curricItems.push({ track: 'namaz', type: 'component', label: namazParts[i], order: i + 1 })
  }

  const savedCurric = await CurriculumItem.insertMany(curricItems)
  console.log(`   ${savedCurric.length} curriculum items created`)

  // ──────────────────────────────────────
  // 3. USERS & PROFILES
  // ──────────────────────────────────────
  console.log('\n3. Seeding Users...')
  const creds = []

  // Helper to create a user
  async function createUser(email, displayName, roleKeys, extra = {}) {
    const existing = await User.findOne({ email })
    if (existing) { console.log(`   SKIP ${email}`); return existing }
    const user = new User({
      email,
      password: PASSWORD,
      displayName,
      roles: roleKeys.map(k => roles[k]),
      status: 'active',
      ...extra,
    })
    await user.save()
    creds.push({ email, password: PASSWORD, displayName, roles: roleKeys.join(', ') })
    console.log(`   ${email} [${roleKeys.join(', ')}]`)
    return user
  }

  // Super Admin
  const superAdmin = await createUser('superadmin@hidaya.com', 'Muhammad Owais', ['super_admin'])
  // Admin
  const adminUser = await createUser('admin@hidaya.com', 'Fatima Zahra', ['admin'])
  // Principal
  const principal = await createUser('principal@hidaya.com', 'Ustaz Rashid Ahmed', ['principal'])
  // Coordinators
  const coord1 = await createUser('coordinator1@hidaya.com', 'Hira Malik', ['coordinator'])
  const coord2 = await createUser('coordinator2@hidaya.com', 'Adnan Qureshi', ['coordinator'])
  // QCI
  const qci = await createUser('qci@hidaya.com', 'Ustaz Imran Siddiqui', ['qci'])
  // QCM
  const qcm = await createUser('qcm@hidaya.com', 'Ustaza Rabia Sheikh', ['qcm'])

  // Staff profiles for admin roles
  for (const u of [superAdmin, adminUser, principal, coord1, coord2, qci, qcm]) {
    await StaffProfile.findOneAndUpdate(
      { userId: u._id },
      { userId: u._id, title: u.displayName.startsWith('Ustaz') ? 'Senior Instructor' : 'Staff', department: 'Administration' },
      { upsert: true }
    )
  }

  // ──────────────────────────────────────
  // 4. TUTORS (10)
  // ──────────────────────────────────────
  console.log('\n4. Seeding Tutors...')
  const tutors = []
  const tutorUsers = []
  const SKILL_LEVELS = ['beginner', 'medium', 'professional', 'expert']

  for (let i = 0; i < 10; i++) {
    const name = tutorName(i)
    const email = `tutor${i + 1}@hidaya.com`
    const user = await createUser(email, name, ['tutor'])

    const subjects = [TRACKS[i % TRACKS.length]]
    if (i % 3 === 0) subjects.push(TRACKS[(i + 2) % TRACKS.length])

    const shiftWindows = []
    // Mon-Sat night shift (academy runs 8 PM onwards for overseas students)
    for (let d = 1; d <= 6; d++) {
      shiftWindows.push({ dayOfWeek: d, startTime: '20:00', endTime: '23:30', timezone: 'Asia/Karachi' })
    }

    const tutor = await TutorProfile.findOneAndUpdate(
      { userId: user._id },
      {
        tutorId: `TUT-${String(i + 1).padStart(3, '0')}`,
        userId: user._id,
        name,
        email,
        phone: `+92${randomBetween(300, 345)}${randomBetween(1000000, 9999999)}`,
        skillLevel: SKILL_LEVELS[i % SKILL_LEVELS.length],
        roomNo: `R-${i + 1}`,
        meetLink: `https://meet.google.com/abc-defg-${String(i + 1).padStart(3, '0')}`,
        shiftWindows,
        status: 'active',
        salary: { baseAmount: randomBetween(15, 35) * 1000, currency: 'PKR' },
        subjects,
      },
      { upsert: true, new: true }
    )

    await User.updateOne({ _id: user._id }, { linkedTutorId: tutor._id })
    tutors.push(tutor)
    tutorUsers.push(user)
  }

  // ──────────────────────────────────────
  // 5. STUDENTS (40)
  // ──────────────────────────────────────
  console.log('\n5. Seeding Students (40)...')
  const students = []
  const studentUsers = []

  for (let i = 0; i < 40; i++) {
    const name = nextStudentName()
    const countryIdx = i % COUNTRIES.length
    const fatherName = FATHER_NAMES[i % FATHER_NAMES.length]
    const courses = [TRACKS[i % TRACKS.length]]
    if (i % 4 === 0) courses.push(TRACKS[(i + 3) % TRACKS.length])

    let status
    if (i < 30) status = 'active'
    else if (i < 34) status = 'leave'
    else if (i < 38) status = 'left'
    else status = 'pending'

    const student = await Student.create({
      rollNo: `HQ-${String(i + 1).padStart(4, '0')}`,
      name,
      parentsName: fatherName,
      dob: new Date(2010 + (i % 12), i % 12, (i % 28) + 1),
      joiningDate: monthsAgo(randomBetween(1, 18)),
      country: COUNTRIES[countryIdx],
      timezone: TIMEZONES[countryIdx],
      guardians: [
        { relation: 'father', name: fatherName, phone: `+92${randomBetween(300, 345)}${randomBetween(1000000, 9999999)}`, email: `parent${i + 1}@example.com`, isWhatsappRecipient: true },
        { relation: 'mother', name: `${randomFrom(FEMALE_FIRST)} ${LAST_NAMES[i % LAST_NAMES.length]}`, phone: '', email: '' },
      ],
      whatsappNumber: `+92${randomBetween(300, 345)}${randomBetween(1000000, 9999999)}`,
      courseLabels: courses,
      placementLevel: PLACEMENT[i % PLACEMENT.length],
      sect: SECTS[i % SECTS.length],
      specialNeeds: i % 10 === 0 ? [{ type: 'learning_difficulty', note: 'Needs extra patience' }] : [],
      referredBy: i % 5 === 0 ? 'Social Media' : i % 5 === 1 ? 'Friend' : '',
      billing: {
        fee: randomFrom([3000, 4000, 5000, 6000, 8000]),
        amount: randomFrom([3000, 4000, 5000, 6000, 8000]),
        currency: countryIdx < 3 ? 'PKR' : countryIdx < 6 ? 'USD' : 'GBP',
        whoPays: 'father',
        cycle: 'monthly',
        status: status === 'active' ? randomFrom(['paid', 'pending', 'paid', 'paid']) : 'pending',
      },
      status,
    })

    students.push(student)

    // Create portal user account for first 15 students
    if (i < 15) {
      const email = `student${i + 1}@hidaya.com`
      const user = await createUser(email, name, ['student'], { linkedStudentId: student._id })
      await Student.updateOne({ _id: student._id }, { userId: user._id })
      studentUsers.push(user)
    }
  }

  // ──────────────────────────────────────
  // 6. FAMILIES & RELATIONSHIPS
  // ──────────────────────────────────────
  console.log('\n6. Seeding Families & Relationships...')
  // Group some students as siblings
  const familyPairs = [[0, 1], [2, 3], [5, 6, 7], [10, 11], [15, 16]]
  for (let fi = 0; fi < familyPairs.length; fi++) {
    const ids = familyPairs[fi]
    const family = await Family.create({
      familyCode: `FAM-${String(fi + 1).padStart(3, '0')}`,
      primaryGuardian: {
        name: students[ids[0]].parentsName,
        phone: students[ids[0]].guardians[0]?.phone || '',
        email: `family${fi + 1}@example.com`,
        relation: 'father',
      },
      members: ids.map(i => students[i]._id),
    })
    for (const id of ids) {
      await Student.updateOne({ _id: students[id]._id }, { familyId: family._id })
    }
    // Create sibling relationships
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        await StudentRelationship.create({
          studentA: students[ids[a]]._id,
          studentB: students[ids[b]]._id,
          type: 'sibling',
        })
      }
    }
    console.log(`   Family FAM-${String(fi + 1).padStart(3, '0')} (${ids.length} members)`)
  }

  // ──────────────────────────────────────
  // 7. ASSIGNMENTS (tutor ↔ student)
  // ──────────────────────────────────────
  console.log('\n7. Seeding Assignments...')
  const assignments = []
  const activeStudents = students.filter(s => s.status === 'active')
  for (let i = 0; i < activeStudents.length; i++) {
    const st = activeStudents[i]
    const tutor = tutors[i % tutors.length]
    const track = st.courseLabels[0]
    const a = await Assignment.create({
      studentId: st._id,
      tutorId: tutor._id,
      track,
      startDate: st.joiningDate,
      assignedBy: coord1._id,
    })
    assignments.push(a)
  }
  console.log(`   ${assignments.length} assignments created`)

  // ──────────────────────────────────────
  // 8. CLASS SLOTS & SESSIONS
  // ──────────────────────────────────────
  console.log('\n8. Seeding Class Slots & Sessions...')
  const slots = []
  const sessions = []

  for (let i = 0; i < activeStudents.length; i++) {
    const st = activeStudents[i]
    const tutor = tutors[i % tutors.length]
    const track = st.courseLabels[0]
    const day1 = (i % 5) + 1
    const day2 = ((i + 2) % 5) + 1
    // Night-shift evening slots (8:00–10:45 PM) so they land inside the Session
    // Board's default night window and show immediately in the demo.
    const startTime = randomTime(20, 22)

    for (const day of [day1, day2]) {
      const slot = await ClassSlot.create({
        studentId: st._id,
        tutorId: tutor._id,
        track,
        dayOfWeek: day,
        startTime,
        durationMinutes: 30,
        meetLink: tutor.meetLink,
      })
      slots.push(slot)
    }

    // Generate sessions for last 60 days
    for (let d = 60; d >= 0; d--) {
      const date = daysAgo(d)
      const dayOfWeek = date.getDay()
      if (dayOfWeek !== day1 && dayOfWeek !== day2) continue
      if (dayOfWeek === 0) continue // skip Sunday

      const sTime = startTime
      const eTime = addMinutes(sTime, 30)
      const isFuture = d < 1

      let status
      if (isFuture) status = 'scheduled'
      else if (d < 3 && i % 8 === 0) status = 'missed'
      else status = randomFrom(['completed', 'completed', 'completed', 'completed', 'missed'])

      const sess = await ClassSession.create({
        slotId: slots[slots.length - 1]._id,
        studentId: st._id,
        tutorId: tutor._id,
        date,
        scheduledStart: sTime,
        scheduledEnd: eTime,
        status,
        attendance: status === 'completed' ? randomFrom(['on_time', 'on_time', 'on_time', 'late']) : status === 'missed' ? 'no_show' : '',
        computedDuration: status === 'completed' ? randomBetween(25, 35) : 0,
        notes: status === 'missed' ? 'Student did not join' : '',
      })
      sessions.push(sess)
    }
  }
  console.log(`   ${slots.length} slots, ${sessions.length} sessions created`)

  // ──────────────────────────────────────
  // 9. LESSON ENTRIES
  // ──────────────────────────────────────
  console.log('\n9. Seeding Lesson Entries...')
  const completedSessions = sessions.filter(s => s.status === 'completed')
  let lessonCount = 0
  const lessonEntries = []

  for (const sess of completedSessions) {
    if (Math.random() < 0.15) continue // 15% chance no lesson logged
    const curricPool = savedCurric.filter(c => ['qaida', 'quran', 'hifz'].includes(c.track))
    const item1 = randomFrom(curricPool)
    const entry = await LessonEntry.create({
      sessionId: sess._id,
      studentId: sess.studentId,
      tutorId: sess.tutorId,
      date: sess.date,
      classStart: sess.scheduledStart,
      classEnd: sess.scheduledEnd,
      kind: Math.random() < 0.8 ? 'daily' : 'revision',
      items: [{ curriculumItemId: item1._id, fromUnit: 'Line 1', toUnit: `Line ${randomBetween(3, 10)}` }],
      notes: Math.random() < 0.3 ? randomFrom(['Good progress today', 'Needs more practice on tajweed rules', 'Excellent recitation', 'Revised previous lesson', 'Student was attentive']) : '',
    })
    lessonEntries.push(entry)
    lessonCount++
  }
  console.log(`   ${lessonCount} lesson entries created`)

  // ──────────────────────────────────────
  // 10. PERMANENT LESSONS
  // ──────────────────────────────────────
  console.log('\n10. Seeding Permanent Lessons...')
  let permCount = 0
  for (let i = 0; i < 25; i++) {
    const st = randomFrom(activeStudents)
    const tutor = tutors[activeStudents.indexOf(st) % tutors.length] || tutors[0]
    const ci = randomFrom(savedCurric)
    const status = randomFrom(['approved', 'approved', 'approved', 'pending_approval', 'rejected'])
    await PermanentLesson.create({
      studentId: st._id,
      tutorId: tutor._id,
      curriculumItemId: ci._id,
      completedDate: daysAgo(randomBetween(1, 90)),
      status,
      submittedBy: tutorUsers[activeStudents.indexOf(st) % tutorUsers.length]?._id || tutorUsers[0]._id,
      approvedBy: status === 'approved' ? qci._id : undefined,
      approvedAt: status === 'approved' ? daysAgo(randomBetween(0, 5)) : undefined,
      rejectionReason: status === 'rejected' ? 'Video quality not sufficient, please re-record' : '',
      notes: Math.random() < 0.4 ? 'Student demonstrated good memorization' : '',
    })
    permCount++
  }
  console.log(`   ${permCount} permanent lessons created`)

  // ──────────────────────────────────────
  // 11. TUTOR ATTENDANCE
  // ──────────────────────────────────────
  console.log('\n11. Seeding Tutor Attendance...')
  let attCount = 0
  for (const tutor of tutors.filter(t => t.status === 'active')) {
    for (let d = 30; d >= 0; d--) {
      const date = daysAgo(d)
      if (date.getDay() === 0 || date.getDay() === 6) continue // Skip weekends
      const isPresent = Math.random() < 0.85
      await TutorAttendance.create({
        tutorId: tutor._id,
        date,
        checkInAt: isPresent ? new Date(date.getTime() + randomBetween(0, 15) * 60000) : undefined,
        checkOutAt: isPresent ? new Date(date.getTime() + randomBetween(4, 8) * 3600000) : undefined,
        totalHours: isPresent ? randomBetween(4, 8) : 0,
        status: isPresent ? 'present' : (Math.random() < 0.5 ? 'absent' : 'partial'),
      })
      attCount++
    }
  }
  console.log(`   ${attCount} attendance records created`)

  // ──────────────────────────────────────
  // 12. ADMISSION APPLICATIONS
  // ──────────────────────────────────────
  console.log('\n12. Seeding Admission Applications...')
  const admissionStatuses = ['pending', 'pending', 'pending', 'approved', 'approved', 'approved', 'approved', 'rejected']
  for (let i = 0; i < 20; i++) {
    const status = admissionStatuses[i % admissionStatuses.length]
    await AdmissionApplication.create({
      studentName: nextStudentName(),
      parentsName: FATHER_NAMES[i % FATHER_NAMES.length],
      dob: new Date(2012 + (i % 8), i % 12, (i % 28) + 1),
      country: COUNTRIES[i % COUNTRIES.length],
      timezone: TIMEZONES[i % TIMEZONES.length],
      guardians: [
        { relation: 'father', name: FATHER_NAMES[i % FATHER_NAMES.length], phone: `+92300${randomBetween(1000000, 9999999)}`, isWhatsappRecipient: true },
      ],
      whatsappNumber: `+92300${randomBetween(1000000, 9999999)}`,
      courseLabels: [TRACKS[i % TRACKS.length]],
      placementLevel: PLACEMENT[i % PLACEMENT.length],
      sect: SECTS[i % SECTS.length],
      heardFrom: randomFrom(['Social Media', 'Friend', 'Google', 'WhatsApp Group', 'Masjid Notice', 'Facebook Ad']),
      status,
      reviewedBy: status !== 'pending' ? adminUser._id : undefined,
      reviewedAt: status !== 'pending' ? daysAgo(randomBetween(1, 10)) : undefined,
      reviewNotes: status === 'rejected' ? 'Age requirement not met' : status === 'approved' ? 'Welcome to Hidaya!' : '',
      createdAt: monthsAgo(randomBetween(0, 6)),
    })
  }
  console.log(`   20 admission applications created`)

  // ──────────────────────────────────────
  // 13. ASSESSMENT TEMPLATES & ASSESSMENTS
  // ──────────────────────────────────────
  console.log('\n13. Seeding Assessments...')
  const template = await AssessmentTemplate.create({
    name: 'Monthly Quran Assessment',
    active: true,
    sections: [
      {
        key: 'recitation', label: 'Recitation Quality',
        fields: [
          { key: 'fluency', label: 'Fluency', type: 'rating', required: true },
          { key: 'tajweed_accuracy', label: 'Tajweed Accuracy', type: 'rating', required: true },
          { key: 'makhraj', label: 'Makhraj', type: 'rating' },
        ],
      },
      {
        key: 'memorization', label: 'Memorization',
        fields: [
          { key: 'retention', label: 'Retention Level', type: 'scale', required: true },
          { key: 'speed', label: 'Recall Speed', type: 'select', options: ['Slow', 'Average', 'Fast', 'Excellent'] },
        ],
      },
      {
        key: 'behavior', label: 'Behavior & Attitude',
        fields: [
          { key: 'attentiveness', label: 'Attentiveness', type: 'rating' },
          { key: 'notes', label: 'Examiner Notes', type: 'text' },
        ],
      },
    ],
    createdBy: qci._id,
  })

  for (let i = 0; i < 30; i++) {
    const st = randomFrom(activeStudents)
    await Assessment.create({
      studentId: st._id,
      templateId: template._id,
      date: daysAgo(randomBetween(1, 90)),
      testTeacherId: randomFrom(tutors)._id,
      regularTeacherId: tutors[activeStudents.indexOf(st) % tutors.length]?._id || tutors[0]._id,
      attendance: Math.random() < 0.9 ? 'present' : 'absent',
      scope: randomFrom(['qaida', 'quran', 'hifz', 'general']),
      responses: [
        { fieldKey: 'fluency', value: randomBetween(1, 5) },
        { fieldKey: 'tajweed_accuracy', value: randomBetween(1, 5) },
        { fieldKey: 'makhraj', value: randomBetween(1, 5) },
        { fieldKey: 'retention', value: randomBetween(1, 10) },
        { fieldKey: 'speed', value: randomFrom(['Slow', 'Average', 'Fast', 'Excellent']) },
        { fieldKey: 'attentiveness', value: randomBetween(1, 5) },
      ],
      overallScore: randomBetween(40, 100),
      examinerNotes: Math.random() < 0.5 ? randomFrom(['Good improvement', 'Needs revision on last para', 'Excellent performance', 'Below expectations', 'Shows great potential']) : '',
      conductedBy: qci._id,
    })
  }
  console.log(`   1 template, 30 assessments created`)

  // ──────────────────────────────────────
  // 14. NOTICES & COMPLAINTS
  // ──────────────────────────────────────
  console.log('\n14. Seeding Notices & Complaints...')
  const noticeMsgs = [
    'Please ensure students have Quran copies ready before class starts',
    'Ramadan schedule: Classes shifted to evening slots from next week',
    'Important: Submit all pending lesson records by Friday',
    'Reminder: Monthly assessment for all Hifz students this Saturday',
    'New curriculum items added for Tajweed — please review',
    'Parent-teacher meeting scheduled for next Wednesday',
    'System maintenance on Sunday 2am-4am — portal may be unavailable',
    'Congratulations to the Hifz batch on completing Para 15!',
  ]
  const noticeCategories = ['permanent', 'urgent', 'temporary', 'information', 'student_specific', 'information', 'urgent', 'permanent']
  for (let i = 0; i < noticeMsgs.length; i++) {
    const cat = noticeCategories[i]
    const isUrgent = cat === 'urgent'
    await Notice.create({
      type: i < 5 ? 'teacher' : 'student',
      category: cat,
      targetTutorId: i < 5 ? tutors[i % tutors.length]._id : undefined,
      targetStudentId: i >= 5 && cat !== 'student_specific' ? students[i % students.length]._id : undefined,
      targetStudentIds: cat === 'student_specific' ? [students[0]._id, students[1]._id, students[2]._id] : [],
      message: noticeMsgs[i],
      severity: isUrgent ? 'urgent' : i === 2 ? 'warning' : 'info',
      requiresAcknowledgment: isUrgent,
      acknowledgedBy: isUrgent && i === 6 ? [{ userId: tutorUsers[0]._id, acknowledgedAt: daysAgo(1) }] : [],
      autoDisableAt: cat === 'temporary' ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : undefined,
      classTime: cat === 'information' ? '17:00' : undefined,
      active: i < 7,
      createdBy: coord1._id,
      createdAt: daysAgo(randomBetween(0, 30)),
    })
  }

  const complaintTexts = [
    'Class was cancelled without prior notice last Tuesday',
    'Teacher is not following the assigned curriculum track',
    'Student reports audio quality issues during online classes',
    'Parent concerned about pace of Quran reading progress',
    'Missed 3 classes this month — need to reschedule',
    'Request for teacher change due to scheduling conflict',
  ]
  for (let i = 0; i < complaintTexts.length; i++) {
    const resolved = i < 3
    await Complaint.create({
      date: daysAgo(randomBetween(1, 30)),
      representative: randomFrom(['principal', 'hqci', 'coordinator', 'admin']),
      studentId: students[i % students.length]._id,
      againstTutorId: i % 3 === 0 ? tutors[i % tutors.length]._id : undefined,
      complainant: randomFrom(['father', 'mother', 'student']),
      text: complaintTexts[i],
      visibility: i % 2 === 0 ? 'all_staff' : 'teacher_only',
      status: resolved ? 'resolved' : 'open',
      createdBy: coord1._id,
      resolvedBy: resolved ? adminUser._id : undefined,
      resolvedAt: resolved ? daysAgo(randomBetween(0, 5)) : undefined,
      resolution: resolved ? 'Issue addressed with the tutor. Schedule adjusted accordingly.' : '',
    })
  }
  console.log(`   ${noticeMsgs.length} notices, ${complaintTexts.length} complaints created`)

  // ──────────────────────────────────────
  // 15. INVOICES
  // ──────────────────────────────────────
  console.log('\n15. Seeding Invoices...')
  const invoiceStatuses = ['paid', 'paid', 'paid', 'sent', 'sent', 'overdue', 'draft', 'partially_paid']
  for (let i = 0; i < 35; i++) {
    const st = activeStudents[i % activeStudents.length]
    const amount = st.billing.fee || 5000
    const status = invoiceStatuses[i % invoiceStatuses.length]
    await Invoice.create({
      invoiceNo: `INV-${new Date().getFullYear()}-${String(i + 1).padStart(4, '0')}`,
      studentId: st._id,
      items: [
        { description: `Monthly Tuition — ${st.courseLabels[0]}`, amount, quantity: 1 },
      ],
      amount,
      currency: st.billing.currency || 'PKR',
      dueDate: daysAgo(-randomBetween(0, 15)),
      status,
      paidAmount: status === 'paid' ? amount : status === 'partially_paid' ? Math.round(amount * 0.5) : 0,
      notes: status === 'overdue' ? 'Reminder sent via WhatsApp' : '',
      createdBy: adminUser._id,
      createdAt: monthsAgo(randomBetween(0, 4)),
    })
  }
  console.log(`   35 invoices created`)

  // ──────────────────────────────────────
  // 16. SALARY RECORDS
  // ──────────────────────────────────────
  console.log('\n16. Seeding Salary Records...')
  const now = new Date()
  let salaryCount = 0
  for (const tutor of tutors.filter(t => t.status === 'active')) {
    for (let m = 3; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1)
      const base = tutor.salary.baseAmount
      const deductionAmt = Math.random() < 0.3 ? randomBetween(500, 2000) : 0
      const bonus = Math.random() < 0.2 ? randomBetween(1000, 3000) : 0
      await SalaryRecord.create({
        tutorId: tutor._id,
        month: d.getMonth() + 1,
        year: d.getFullYear(),
        baseAmount: base,
        currency: tutor.salary.currency,
        deductions: deductionAmt > 0 ? [{ reason: 'Late attendance', amount: deductionAmt }] : [],
        totalDeductions: deductionAmt,
        bonuses: bonus,
        netPayable: base - deductionAmt + bonus,
        presentDays: randomBetween(18, 25),
        absentDays: randomBetween(0, 4),
        totalHours: randomBetween(80, 160),
        status: m === 0 ? 'draft' : randomFrom(['finalized', 'paid', 'paid']),
        generatedBy: adminUser._id,
      })
      salaryCount++
    }
  }
  console.log(`   ${salaryCount} salary records created`)

  // ──────────────────────────────────────
  // 16b. SALARY INCREMENTS
  // ──────────────────────────────────────
  console.log('\n16b. Seeding Salary Increments...')
  let incCount = 0
  for (const tutor of tutors.filter(t => t.status === 'active').slice(0, 6)) {
    const base = tutor.salary.baseAmount
    // Simulate 2-3 historical increments per tutor
    let currentAmount = Math.round(base * 0.7) // start lower
    const numIncs = randomBetween(2, 3)
    for (let j = 0; j < numIncs; j++) {
      const prevAmount = currentAmount
      const incPct = randomBetween(5, 20)
      currentAmount = Math.round(prevAmount * (1 + incPct / 100))
      if (j === numIncs - 1) currentAmount = base // final increment matches current base

      await SalaryIncrement.create({
        tutorId: tutor._id,
        previousAmount: prevAmount,
        newAmount: currentAmount,
        incrementAmount: currentAmount - prevAmount,
        incrementPercentage: Math.round(((currentAmount - prevAmount) / prevAmount) * 10000) / 100,
        currency: tutor.salary.currency,
        effectiveDate: monthsAgo((numIncs - j) * 4),
        reason: randomFrom([
          'Annual performance review',
          'Promotion to senior tutor',
          'Salary adjustment for inflation',
          'Merit-based increment',
          'Completion of 1 year',
          'Positive student feedback',
        ]),
        approvedBy: adminUser._id,
      })
      incCount++
    }
  }
  console.log(`   ${incCount} salary increments created`)

  // ──────────────────────────────────────
  // 16c. CERTIFICATES
  // ──────────────────────────────────────
  console.log('\n16c. Seeding Certificates...')
  const certTypes = ['qaida_completion', 'para_completion', 'course_completion', 'tajweed_completion', 'assessment_excellence', 'attendance_excellence', 'hifz_completion', 'custom']
  const certTitles = {
    qaida_completion: 'Certificate of Qaida Completion',
    para_completion: 'Certificate of Para Completion',
    course_completion: 'Certificate of Course Completion',
    tajweed_completion: 'Certificate of Tajweed Mastery',
    assessment_excellence: 'Certificate of Academic Excellence',
    attendance_excellence: 'Certificate of Outstanding Attendance',
    hifz_completion: 'Certificate of Hifz Achievement',
    custom: 'Special Recognition Certificate',
  }
  const certDetails = {
    qaida_completion: 'Has successfully completed the entire Noorani Qaida with excellent recitation skills.',
    para_completion: 'Has successfully completed recitation of the assigned Para with proper Tajweed.',
    course_completion: 'Has demonstrated exceptional dedication in completing the assigned course curriculum.',
    tajweed_completion: 'Has mastered the rules of Tajweed and applied them consistently in Quran recitation.',
    assessment_excellence: 'Has achieved outstanding results in the monthly assessment with a score above 90%.',
    attendance_excellence: 'Has maintained 95%+ attendance throughout the semester. Exemplary commitment!',
    hifz_completion: 'Has memorized and revised the assigned portions of the Holy Quran with accuracy.',
    custom: 'In recognition of outstanding contribution to the Hidaya Online learning community.',
  }
  const designs = ['classic', 'modern', 'ornate', 'minimal']
  let certCount = 0
  for (let i = 0; i < 20; i++) {
    const st = activeStudents[i % activeStudents.length]
    const type = certTypes[i % certTypes.length]
    await Certificate.create({
      studentId: st._id,
      type,
      title: certTitles[type],
      details: certDetails[type],
      templateDesign: designs[i % designs.length],
      issuedDate: daysAgo(randomBetween(1, 120)),
      issuedBy: randomFrom([adminUser._id, principal._id, qci._id]),
      meta: {
        trackCompleted: type.includes('qaida') ? 'qaida' : type.includes('hifz') ? 'hifz' : type.includes('tajweed') ? 'tajweed' : 'quran',
        assessmentScore: type === 'assessment_excellence' ? randomBetween(90, 100) : undefined,
      },
    })
    certCount++
  }
  console.log(`   ${certCount} certificates created`)

  // ──────────────────────────────────────
  // 16d. ADMIN NOTES ON STUDENTS
  // ──────────────────────────────────────
  console.log('\n16d. Seeding Admin Notes on Students...')
  const adminNoteTexts = [
    'Student shows excellent progress in Tajweed. Consider advancing to next level.',
    'Parent requested schedule change to evening slot — pending confirmation.',
    'Had behavioral issue during class on June 5. Counseling session scheduled.',
    'Consistently late to classes. WhatsApp reminder sent to parent.',
    'Top performer in monthly assessment. Consider for excellence certificate.',
    'Family moving to new city next month — may need timezone adjustment.',
    'Fee payment overdue for 2 months. Follow up with father.',
    'Student expressed interest in starting Hifz track.',
    'Absent for 2 weeks due to health issues. Doctor note received.',
    'Recommended by QCI for special recognition.',
  ]
  let noteCount = 0
  for (let i = 0; i < 15; i++) {
    const st = students[i]
    const numNotes = randomBetween(1, 3)
    const notes = []
    for (let n = 0; n < numNotes; n++) {
      notes.push({
        text: adminNoteTexts[(i * 3 + n) % adminNoteTexts.length],
        createdBy: randomFrom([adminUser._id, coord1._id, coord2._id, principal._id]),
        createdAt: daysAgo(randomBetween(1, 60)),
      })
      noteCount++
    }
    await Student.updateOne({ _id: st._id }, { $set: { adminNotes: notes } })
  }
  console.log(`   ${noteCount} admin notes added to students`)

  // ──────────────────────────────────────
  // 17. CHAT THREADS & MESSAGES
  // ──────────────────────────────────────
  console.log('\n17. Seeding Chat...')
  const allPortalUsers = [superAdmin, adminUser, principal, coord1, coord2, qci, qcm, ...tutorUsers, ...studentUsers]

  // Channels
  const channels = [
    { name: 'General', label: 'general', desc: 'General discussion for all staff' },
    { name: 'Announcements', label: 'announcement', desc: 'Official announcements only' },
    { name: 'Tutors Lounge', label: 'staff', desc: 'Tutor-only discussion' },
    { name: 'QC Team', label: 'support', desc: 'Quality control discussions' },
  ]
  const staffIds = [superAdmin, adminUser, principal, coord1, coord2, qci, qcm, ...tutorUsers].map(u => u._id)

  for (const ch of channels) {
    const thread = await ChatThread.create({
      type: 'channel',
      name: ch.name,
      description: ch.desc,
      label: ch.label,
      createdBy: adminUser._id,
      participants: staffIds,
      lastMessageAt: daysAgo(0),
    })

    // Add messages
    const msgTexts = [
      'Assalamu Alaikum everyone!',
      'Reminder: Please submit attendance by 5 PM today.',
      'The new curriculum updates are live. Please check the Curriculum section.',
      'JazakAllah Khair to everyone for a productive week.',
      'Is anyone available to cover the 3 PM slot tomorrow?',
      'Alhamdulillah, student Ahmed completed his Qaida today!',
      'Please note the schedule change for next week.',
    ]
    for (let m = 0; m < 5; m++) {
      const sender = randomFrom(staffIds)
      await Message.create({
        threadId: thread._id,
        senderId: sender,
        body: msgTexts[m % msgTexts.length],
        format: 'plain',
        createdAt: daysAgo(randomBetween(0, 7)),
      })
    }
  }

  // DMs
  for (let i = 0; i < 8; i++) {
    const p1 = allPortalUsers[i % allPortalUsers.length]
    const p2 = allPortalUsers[(i + 3) % allPortalUsers.length]
    if (p1._id.equals(p2._id)) continue

    const thread = await ChatThread.create({
      type: 'dm',
      createdBy: p1._id,
      participants: [p1._id, p2._id],
      lastMessageAt: daysAgo(randomBetween(0, 5)),
    })

    const dmMsgs = [
      'Assalamu Alaikum, can we discuss the student progress report?',
      'Wa Alaikum Assalam, sure. When are you available?',
      'How about after Zuhr today?',
      'That works. I\'ll send you the details.',
    ]
    for (let m = 0; m < dmMsgs.length; m++) {
      await Message.create({
        threadId: thread._id,
        senderId: m % 2 === 0 ? p1._id : p2._id,
        body: dmMsgs[m],
        format: 'plain',
        createdAt: daysAgo(randomBetween(0, 3)),
      })
    }
  }
  console.log(`   ${channels.length} channels, 8 DMs with messages created`)

  // ──────────────────────────────────────
  // 18. NOTIFICATIONS
  // ──────────────────────────────────────
  console.log('\n18. Seeding Notifications...')
  const notifTypes = [
    { type: 'admission', title: 'New Admission Application', body: 'A new student has applied for enrollment.' },
    { type: 'lesson_approved', title: 'Lesson Approved', body: 'Your permanent lesson submission has been approved.' },
    { type: 'lesson_rejected', title: 'Lesson Rejected', body: 'Your lesson submission was rejected. Please re-record.' },
    { type: 'class_start', title: 'Class Starting Soon', body: 'Your class starts in 10 minutes.' },
    { type: 'notice', title: 'New Notice', body: 'A new notice has been posted for your attention.' },
    { type: 'complaint', title: 'Complaint Filed', body: 'A new complaint has been filed regarding a class.' },
    { type: 'assignment', title: 'New Assignment', body: 'You have been assigned to a new student.' },
    { type: 'system', title: 'System Update', body: 'Portal has been updated with new features.' },
  ]
  for (let i = 0; i < 40; i++) {
    const n = notifTypes[i % notifTypes.length]
    await Notification.create({
      userId: allPortalUsers[i % allPortalUsers.length]._id,
      type: n.type,
      title: n.title,
      body: n.body,
      readAt: Math.random() < 0.5 ? daysAgo(randomBetween(0, 3)) : undefined,
      createdAt: daysAgo(randomBetween(0, 14)),
    })
  }
  console.log(`   40 notifications created`)

  // ──────────────────────────────────────
  // WRITE CREDENTIALS FILE
  // ──────────────────────────────────────
  console.log('\n📝 Writing credentials file...')
  const credLines = [
    '# Hidaya Portal — Demo Credentials',
    '',
    `> All accounts use password: \`${PASSWORD}\``,
    `> Generated: ${new Date().toISOString().split('T')[0]}`,
    '',
    '## Admin & Staff Accounts',
    '',
    '| Role | Email | Name |',
    '|------|-------|------|',
    ...creds.filter(c => !c.roles.includes('tutor') && !c.roles.includes('student')).map(c =>
      `| ${c.roles} | ${c.email} | ${c.displayName} |`
    ),
    '',
    '## Tutor Accounts',
    '',
    '| Email | Name |',
    '|-------|------|',
    ...creds.filter(c => c.roles === 'tutor').map(c =>
      `| ${c.email} | ${c.displayName} |`
    ),
    '',
    '## Student Accounts',
    '',
    '| Email | Name |',
    '|-------|------|',
    ...creds.filter(c => c.roles === 'student').map(c =>
      `| ${c.email} | ${c.displayName} |`
    ),
    '',
    '## Summary',
    '',
    `- **${creds.filter(c => !c.roles.includes('tutor') && !c.roles.includes('student')).length}** admin/staff accounts`,
    `- **${creds.filter(c => c.roles === 'tutor').length}** tutor accounts`,
    `- **${creds.filter(c => c.roles === 'student').length}** student accounts`,
    `- **${students.length}** total students (${activeStudents.length} active)`,
    `- **${tutors.length}** tutors`,
    `- **${sessions.length}** class sessions`,
    `- **${lessonCount}** lesson entries`,
    `- **${savedCurric.length}** curriculum items`,
    `- **${incCount}** salary increments`,
    `- **${certCount}** certificates`,
    '',
  ]

  fs.writeFileSync(path.join(__dirname, 'DEMO_CREDENTIALS.md'), credLines.join('\n'))
  console.log('   Written to DEMO_CREDENTIALS.md')

  // ──────────────────────────────────────
  // FINAL SUMMARY
  // ──────────────────────────────────────
  console.log('\n' + '═'.repeat(52))
  console.log('  SEED COMPLETE')
  console.log('═'.repeat(52))
  console.log(`  Roles:             ${await Role.countDocuments()}`)
  console.log(`  Users:             ${await User.countDocuments()}`)
  console.log(`  Students:          ${await Student.countDocuments()}`)
  console.log(`  Tutors:            ${await TutorProfile.countDocuments()}`)
  console.log(`  Families:          ${await Family.countDocuments()}`)
  console.log(`  Assignments:       ${await Assignment.countDocuments()}`)
  console.log(`  Class Slots:       ${await ClassSlot.countDocuments()}`)
  console.log(`  Class Sessions:    ${await ClassSession.countDocuments()}`)
  console.log(`  Lesson Entries:    ${await LessonEntry.countDocuments()}`)
  console.log(`  Permanent Lessons: ${await PermanentLesson.countDocuments()}`)
  console.log(`  Curriculum Items:  ${await CurriculumItem.countDocuments()}`)
  console.log(`  Assessments:       ${await Assessment.countDocuments()}`)
  console.log(`  Admissions:        ${await AdmissionApplication.countDocuments()}`)
  console.log(`  Attendance:        ${await TutorAttendance.countDocuments()}`)
  console.log(`  Notices:           ${await Notice.countDocuments()}`)
  console.log(`  Complaints:        ${await Complaint.countDocuments()}`)
  console.log(`  Invoices:          ${await Invoice.countDocuments()}`)
  console.log(`  Salary Records:    ${await SalaryRecord.countDocuments()}`)
  console.log(`  Salary Increments: ${await SalaryIncrement.countDocuments()}`)
  console.log(`  Certificates:      ${await Certificate.countDocuments()}`)
  console.log(`  Chat Threads:      ${await ChatThread.countDocuments()}`)
  console.log(`  Messages:          ${await Message.countDocuments()}`)
  console.log(`  Notifications:     ${await Notification.countDocuments()}`)
  console.log('═'.repeat(52))

  await mongoose.disconnect()
  console.log('\nDone. ✅')
}

seed().catch(err => {
  console.error('\n❌ Seed failed:', err)
  process.exit(1)
})
