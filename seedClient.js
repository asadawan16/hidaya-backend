/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║        HIDAYA PORTAL — CLIENT DEMO SEED (Focused)           ║
 * ║                                                              ║
 * ║  10 students · 4 tutors · 3 families · rich history          ║
 * ║  Every tab, section, and page populated with realistic data  ║
 * ║                                                              ║
 * ║  Usage:  node seedClient.js          (fresh seed)            ║
 * ║          node seedClient.js --reset  (wipe + re-seed)        ║
 * ╚══════════════════════════════════════════════════════════════╝
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
import StudentStatusHistory from './models/StudentStatusHistory.js'
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

// ── Helpers ──
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(10, 0, 0, 0); return d }
const monthsAgo = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); d.setDate(15); return d }
const rand = (a) => a[Math.floor(Math.random() * a.length)]
const randN = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const pad = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
const addMin = (t, mins) => { const [h, m] = t.split(':').map(Number); const tot = h * 60 + m + mins; return pad(Math.floor(tot / 60) % 24, tot % 60) }

// ══════════════════════════════════════════════
async function seed() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to MongoDB\n')

  // ── RESET ──
  if (RESET) {
    console.log('🗑️  Wiping ALL portal collections...')
    const models = [Role, User, Student, TutorProfile, StaffProfile, Family, StudentRelationship, StudentStatusHistory,
      AdmissionApplication, ClassSlot, ClassSession, TutorAttendance, LessonEntry, PermanentLesson,
      CurriculumItem, Assignment, AssessmentTemplate, Assessment, Notice, Complaint,
      Invoice, SalaryRecord, SalaryIncrement, Certificate, ChatThread, Message, Notification]
    await Promise.all(models.map(M => M.deleteMany({})))
    console.log('   Done.\n')
  }

  const creds = []
  const mkUser = async (email, name, roleKeys, extra = {}) => {
    let u = await User.findOne({ email })
    if (u) return u
    u = new User({ email, password: PASSWORD, displayName: name, roles: roleKeys.map(k => roles[k]), status: 'active', ...extra })
    await u.save()
    creds.push({ email, password: PASSWORD, name, roles: roleKeys.join(', ') })
    return u
  }

  // ════════════════════════════════════════
  // 1. ROLES
  // ════════════════════════════════════════
  console.log('1. Roles')
  const ROLE_DEFS = ['super_admin', 'admin', 'principal', 'coordinator', 'qci', 'qcm', 'tutor', 'student']
  const ROLE_NAMES = { super_admin: 'Super Admin', admin: 'Admin', principal: 'Principal', coordinator: 'Coordinator', qci: 'Quality Control Inspector', qcm: 'Quality Control Manager', tutor: 'Tutor', student: 'Student' }
  const roles = {}
  for (const key of ROLE_DEFS) {
    const r = await Role.findOneAndUpdate({ key }, { name: ROLE_NAMES[key], permissions: DEFAULT_ROLE_PERMISSIONS[key] || [], system: key === 'super_admin' || key === 'admin' }, { upsert: true, new: true })
    roles[key] = r._id
    console.log(`   ${key} (${(DEFAULT_ROLE_PERMISSIONS[key] || []).length} perms)`)
  }

  // ════════════════════════════════════════
  // 2. CURRICULUM (full — all tracks)
  // ════════════════════════════════════════
  console.log('\n2. Curriculum')
  const ci = []
  // Qaida 30 pages
  for (let i = 1; i <= 30; i++) ci.push({ track: 'qaida', type: 'page', label: `Qaida Page ${i}`, order: i })
  // Hifz 30 paras
  for (let i = 1; i <= 30; i++) ci.push({ track: 'hifz', type: 'para', label: `Para ${i}`, order: i })
  // Quran 20 surahs
  const surahs = ['Al-Fatiha','Al-Baqarah','Aal-e-Imran','An-Nisa','Al-Maidah','Al-Anam','Al-Araf','Al-Anfal','At-Tawbah','Yunus','Hud','Yusuf','Ar-Rad','Ibrahim','Al-Hijr','An-Nahl','Al-Isra','Al-Kahf','Maryam','Ta-Ha']
  surahs.forEach((s, i) => ci.push({ track: 'quran', type: 'surah', label: s, order: i + 1 }))
  // Kalima 6
  ;['Kalima Tayyaba','Kalima Shahadat','Kalima Tamjeed','Kalima Tauheed','Kalima Astaghfar','Kalima Radde Kufr'].forEach((k, i) => ci.push({ track: 'kalima', type: 'kalima', label: k, order: i + 1 }))
  // Duas 10
  ;['Dua Before Eating','Dua After Eating','Dua Before Sleeping','Dua After Waking Up','Dua Entering Masjid','Dua Leaving Masjid','Dua for Parents','Dua for Guidance','Dua Before Travel','Dua After Travel'].forEach((d, i) => ci.push({ track: 'dua', type: 'dua', label: d, order: i + 1 }))
  // Namaz 10
  ;['Wudu Steps','Niyyah','Takbeer','Qiyam','Ruku','Sajdah','Tashahhud','Durood','Dua after Tashahhud','Salam'].forEach((n, i) => ci.push({ track: 'namaz', type: 'component', label: n, order: i + 1 }))
  const savedCI = await CurriculumItem.insertMany(ci)
  const ciByTrack = {}
  savedCI.forEach(c => { if (!ciByTrack[c.track]) ciByTrack[c.track] = []; ciByTrack[c.track].push(c) })
  console.log(`   ${savedCI.length} items`)

  // ════════════════════════════════════════
  // 3. STAFF USERS (7)
  // ════════════════════════════════════════
  console.log('\n3. Staff Users')
  const superAdmin = await mkUser('superadmin@hidaya.com', 'Muhammad Owais', ['super_admin'])
  const admin = await mkUser('admin@hidaya.com', 'Fatima Zahra', ['admin'])
  const principal = await mkUser('principal@hidaya.com', 'Ustaz Rashid Ahmed', ['principal'])
  const coord = await mkUser('coordinator@hidaya.com', 'Hira Malik', ['coordinator'])
  const qci = await mkUser('qci@hidaya.com', 'Ustaz Imran Siddiqui', ['qci'])
  const qcm = await mkUser('qcm@hidaya.com', 'Ustaza Rabia Sheikh', ['qcm'])

  for (const u of [superAdmin, admin, principal, coord, qci, qcm]) {
    await StaffProfile.findOneAndUpdate({ userId: u._id }, { userId: u._id, title: 'Staff', department: 'Administration' }, { upsert: true })
  }

  // ════════════════════════════════════════
  // 4. TUTORS (4)
  // ════════════════════════════════════════
  console.log('\n4. Tutors (4)')
  const TUTOR_DATA = [
    { name: 'Ustaz Hamza Hassan', subjects: ['nazra', 'tajweed'], skill: 'expert', salary: 30000 },
    { name: 'Ustaza Hafsa Malik', subjects: ['hifz', 'qaida'], skill: 'professional', salary: 25000 },
    { name: 'Ustaz Bilal Ahmed', subjects: ['tafseer', 'translation'], skill: 'expert', salary: 35000 },
    { name: 'Ustaza Maryam Khan', subjects: ['nazra', 'hifz'], skill: 'professional', salary: 28000 },
  ]
  const tutors = [], tutorUsers = []
  for (let i = 0; i < TUTOR_DATA.length; i++) {
    const td = TUTOR_DATA[i]
    const email = `tutor${i + 1}@hidaya.com`
    const user = await mkUser(email, td.name, ['tutor'])
    const shifts = []
    for (let d = 1; d <= 5; d++) {
      shifts.push({ dayOfWeek: d, startTime: '09:00', endTime: '13:00', timezone: 'Asia/Karachi' })
      shifts.push({ dayOfWeek: d, startTime: '15:00', endTime: '19:00', timezone: 'Asia/Karachi' })
    }
    const t = await TutorProfile.findOneAndUpdate({ userId: user._id }, {
      tutorId: `TUT-${String(i + 1).padStart(3, '0')}`, userId: user._id, name: td.name, email,
      phone: `+9230${randN(0, 9)}${randN(1000000, 9999999)}`, skillLevel: td.skill,
      roomNo: `R-${i + 1}`, meetLink: `https://meet.google.com/hdy-${String(i + 1).padStart(3, '0')}`,
      shiftWindows: shifts, status: 'active',
      salary: { baseAmount: td.salary, currency: 'PKR' }, subjects: td.subjects,
    }, { upsert: true, new: true })
    await User.updateOne({ _id: user._id }, { linkedTutorId: t._id })
    tutors.push(t)
    tutorUsers.push(user)
    console.log(`   ${email} — ${td.name}`)
  }

  // ════════════════════════════════════════
  // 5. STUDENTS (10) — rich data
  // ════════════════════════════════════════
  console.log('\n5. Students (10)')
  const STUDENTS = [
    { name: 'Ahmed Khan', parent: 'Muhammad Arif Khan', country: 'Pakistan', tz: 'Asia/Karachi', courses: ['nazra', 'hifz'], dob: '2014-03-15', status: 'active', fee: 5000, cur: 'PKR', tutor: 0, joined: 14 },
    { name: 'Fatima Ali', parent: 'Zahid Ali', country: 'United Kingdom', tz: 'Europe/London', courses: ['tajweed'], dob: '2013-07-22', status: 'active', fee: 30, cur: 'GBP', tutor: 0, joined: 12 },
    { name: 'Yusuf Hassan', parent: 'Muhammad Arif Khan', country: 'Pakistan', tz: 'Asia/Karachi', courses: ['hifz'], dob: '2012-01-10', status: 'active', fee: 5000, cur: 'PKR', tutor: 1, joined: 18 },
    { name: 'Aisha Malik', parent: 'Khalid Mehmood', country: 'Canada', tz: 'America/Toronto', courses: ['nazra', 'qaida'], dob: '2015-11-05', status: 'active', fee: 40, cur: 'USD', tutor: 3, joined: 10 },
    { name: 'Ibrahim Sheikh', parent: 'Anwar Sheikh', country: 'Saudi Arabia', tz: 'Asia/Riyadh', courses: ['tafseer', 'translation'], dob: '2011-09-18', status: 'active', fee: 35, cur: 'USD', tutor: 2, joined: 16 },
    { name: 'Maryam Qureshi', parent: 'Shahid Qureshi', country: 'Australia', tz: 'Australia/Sydney', courses: ['nazra'], dob: '2016-05-30', status: 'active', fee: 45, cur: 'USD', tutor: 3, joined: 8 },
    { name: 'Omar Siddiqui', parent: 'Khalid Mehmood', country: 'Canada', tz: 'America/Toronto', courses: ['hifz', 'tajweed'], dob: '2013-12-01', status: 'active', fee: 40, cur: 'USD', tutor: 1, joined: 11 },
    { name: 'Zainab Hussain', parent: 'Riaz Hussain', country: 'UAE', tz: 'Asia/Dubai', courses: ['qaida'], dob: '2017-02-14', status: 'active', fee: 120, cur: 'USD', tutor: 1, joined: 6 },
    { name: 'Hassan Raza', parent: 'Nadeem Raza', country: 'Germany', tz: 'Europe/Berlin', courses: ['nazra', 'hifz'], dob: '2014-08-25', status: 'leave', fee: 35, cur: 'EUR', tutor: 0, joined: 15 },
    { name: 'Sara Nawaz', parent: 'Nadeem Raza', country: 'Germany', tz: 'Europe/Berlin', courses: ['tajweed'], dob: '2015-06-12', status: 'active', fee: 35, cur: 'EUR', tutor: 2, joined: 9 },
  ]

  const students = [], studentUsers = []
  for (let i = 0; i < STUDENTS.length; i++) {
    const sd = STUDENTS[i]
    const student = await Student.create({
      rollNo: `HQ-${String(i + 1).padStart(4, '0')}`, name: sd.name, parentsName: sd.parent,
      dob: new Date(sd.dob), joiningDate: monthsAgo(sd.joined),
      country: sd.country, timezone: sd.tz,
      guardians: [
        { relation: 'father', name: sd.parent, phone: `+9230${i}${randN(1000000, 9999999)}`, email: `parent${i + 1}@example.com`, isWhatsappRecipient: true },
        { relation: 'mother', name: `${rand(['Amina', 'Khadija', 'Fatima', 'Hafsa', 'Noor'])} ${sd.name.split(' ')[1]}`, phone: '', email: '' },
      ],
      whatsappNumber: `+9230${i}${randN(1000000, 9999999)}`,
      courseLabels: sd.courses, placementLevel: rand(['beginning', 'qaida_basic', 'quran_good', 'quran_weak']),
      sect: rand(['sunni', 'ahle_hadith']),
      referredBy: rand(['Social Media', 'Friend', 'Google', 'WhatsApp Group', '']),
      billing: { fee: sd.fee, amount: sd.fee, currency: sd.cur, whoPays: 'father', cycle: 'monthly', status: sd.status === 'active' ? rand(['paid', 'paid', 'pending']) : 'pending' },
      status: sd.status,
      notes: i < 3 ? rand(['Excellent student with great potential', 'Consistent in attendance', 'Shows keen interest in memorization']) : '',
      adminNotes: [
        { text: rand(['Good progress this month', 'Parent requested evening slot', 'Recommended for next level', 'Fee payment on time', 'Needs extra attention on tajweed']), createdBy: admin._id, createdAt: daysAgo(randN(5, 30)) },
        { text: rand(['Assessment score improved significantly', 'Absent last week — health issue', 'Completed Qaida ahead of schedule']), createdBy: coord._id, createdAt: daysAgo(randN(1, 15)) },
      ],
    })
    students.push(student)

    // All 10 get portal accounts
    const email = `student${i + 1}@hidaya.com`
    const user = await mkUser(email, sd.name, ['student'], { linkedStudentId: student._id })
    await Student.updateOne({ _id: student._id }, { userId: user._id })
    studentUsers.push(user)

    // Status history
    await StudentStatusHistory.create({ studentId: student._id, status: 'pending', changedBy: admin._id, effectiveDate: monthsAgo(sd.joined), comment: 'New enrollment' })
    await StudentStatusHistory.create({ studentId: student._id, status: 'active', changedBy: admin._id, effectiveDate: monthsAgo(sd.joined - 1), comment: 'Enrollment approved' })
    if (sd.status === 'leave') {
      await StudentStatusHistory.create({ studentId: student._id, status: 'leave', changedBy: coord._id, effectiveDate: daysAgo(10), comment: 'Family vacation — returning in 3 weeks' })
    }

    console.log(`   ${email} — ${sd.name} [${sd.courses.join(', ')}] (${sd.country})`)
  }

  // ════════════════════════════════════════
  // 6. FAMILIES (3)
  // ════════════════════════════════════════
  console.log('\n6. Families')
  // Family 1: Ahmed (0) + Yusuf (2) — siblings, same father
  // Family 2: Aisha (3) + Omar (6) — siblings, same father
  // Family 3: Hassan (8) + Sara (9) — siblings, same father
  const familyDefs = [
    { ids: [0, 2], parent: STUDENTS[0].parent, phone: students[0].guardians[0]?.phone, country: 'Pakistan' },
    { ids: [3, 6], parent: STUDENTS[3].parent, phone: students[3].guardians[0]?.phone, country: 'Canada' },
    { ids: [8, 9], parent: STUDENTS[8].parent, phone: students[8].guardians[0]?.phone, country: 'Germany' },
  ]
  const families = []
  for (let fi = 0; fi < familyDefs.length; fi++) {
    const fd = familyDefs[fi]
    const fam = await Family.create({
      familyCode: `FAM-${String(fi + 1).padStart(3, '0')}`,
      primaryGuardian: { name: fd.parent, phone: fd.phone || '', email: `family${fi + 1}@example.com`, relation: 'father' },
      members: fd.ids.map(i => students[i]._id), notes: `Family based in ${fd.country}. ${fd.ids.length} children enrolled.`,
    })
    families.push(fam)
    for (const id of fd.ids) await Student.updateOne({ _id: students[id]._id }, { familyId: fam._id })
    for (let a = 0; a < fd.ids.length; a++)
      for (let b = a + 1; b < fd.ids.length; b++)
        await StudentRelationship.create({ studentA: students[fd.ids[a]]._id, studentB: students[fd.ids[b]]._id, type: 'sibling' })
    console.log(`   FAM-${String(fi + 1).padStart(3, '0')} (${fd.ids.map(i => students[i].name).join(', ')})`)
  }

  // ════════════════════════════════════════
  // 7. ASSIGNMENTS (tutor ↔ student)
  // ════════════════════════════════════════
  console.log('\n7. Assignments')
  const assignments = []
  const activeStudents = students.filter(s => s.status === 'active')
  for (const st of students) {
    const td = STUDENTS[students.indexOf(st)]
    const tutor = tutors[td.tutor]
    // Past tutor assignment (ended 3 months ago)
    const pastTutor = tutors[(td.tutor + 1) % tutors.length]
    await Assignment.create({
      studentId: st._id, tutorId: pastTutor._id, track: td.courses[0],
      startDate: monthsAgo(td.joined), endDate: monthsAgo(3),
      reason: rand(['Schedule conflict', 'Track specialization change', 'Better timezone match']),
      assignedBy: coord._id,
    })
    // Current assignment
    const a = await Assignment.create({
      studentId: st._id, tutorId: tutor._id, track: td.courses[0],
      startDate: monthsAgo(3), assignedBy: coord._id,
    })
    assignments.push(a)
  }
  console.log(`   ${assignments.length} current + ${students.length} past assignments`)

  // ════════════════════════════════════════
  // 8. CLASS SLOTS & SESSIONS (180 days)
  // ════════════════════════════════════════
  console.log('\n8. Class Slots & Sessions')
  const slots = [], sessions = []
  for (let si = 0; si < students.length; si++) {
    const st = students[si]
    const td = STUDENTS[si]
    const tutor = tutors[td.tutor]
    const day1 = (si % 5) + 1, day2 = ((si + 2) % 5) + 1
    const startH = 9 + (si % 8), startTime = pad(startH, 0)

    for (const day of [day1, day2]) {
      const slot = await ClassSlot.create({
        studentId: st._id, tutorId: tutor._id, track: td.courses[0],
        dayOfWeek: day, startTime, durationMinutes: 30, meetLink: tutor.meetLink,
      })
      slots.push(slot)
    }

    // Sessions over 180 days
    for (let d = 180; d >= 0; d--) {
      const date = daysAgo(d)
      const dow = date.getDay()
      if (dow !== day1 && dow !== day2) continue
      if (dow === 0) continue
      if (st.status === 'leave' && d < 10) continue // on leave students don't have recent sessions

      let status = 'completed'
      if (d === 0) status = 'scheduled'
      else if (d < 3 && si % 5 === 0) status = 'missed'
      else if (Math.random() < 0.08) status = 'missed'

      await ClassSession.create({
        slotId: slots[slots.length - 1]._id, studentId: st._id, tutorId: tutor._id,
        date, scheduledStart: startTime, scheduledEnd: addMin(startTime, 30), status,
        attendance: status === 'completed' ? rand(['on_time', 'on_time', 'on_time', 'late']) : status === 'missed' ? 'no_show' : '',
        computedDuration: status === 'completed' ? randN(25, 35) : 0,
      })
      sessions.push(status)
    }
  }
  console.log(`   ${slots.length} slots, ${sessions.length} sessions`)

  // ════════════════════════════════════════
  // 9. LESSON ENTRIES (~85% of completed sessions)
  // ════════════════════════════════════════
  console.log('\n9. Lesson Entries')
  const completedSessions = await ClassSession.find({ status: 'completed' }).lean()
  let lessonCount = 0
  for (const sess of completedSessions) {
    if (Math.random() < 0.15) continue
    const track = rand(['qaida', 'quran', 'hifz'])
    const pool = ciByTrack[track] || savedCI
    const cItem = rand(pool)
    await LessonEntry.create({
      sessionId: sess._id, studentId: sess.studentId, tutorId: sess.tutorId,
      date: sess.date, classStart: sess.scheduledStart, classEnd: sess.scheduledEnd,
      kind: Math.random() < 0.8 ? 'daily' : 'revision',
      items: [{ curriculumItemId: cItem._id, fromUnit: 'Line 1', toUnit: `Line ${randN(3, 10)}` }],
      notes: Math.random() < 0.3 ? rand(['Good progress', 'Needs tajweed practice', 'Excellent recitation', 'Revised previous lesson', 'Very attentive today']) : '',
    })
    lessonCount++
  }
  console.log(`   ${lessonCount} lesson entries`)

  // ════════════════════════════════════════
  // 10. PERMANENT LESSONS (approved curriculum completions)
  // ════════════════════════════════════════
  console.log('\n10. Permanent Lessons')
  let permCount = 0
  for (const st of activeStudents) {
    const td = STUDENTS[students.indexOf(st)]
    const tutor = tutors[td.tutor]
    // Each student has completed some curriculum items
    const numCompleted = randN(3, 8)
    const track = td.courses[0] === 'nazra' ? 'quran' : td.courses[0] === 'tajweed' ? 'qaida' : td.courses[0]
    const pool = ciByTrack[track] || ciByTrack.qaida
    for (let j = 0; j < Math.min(numCompleted, pool.length); j++) {
      const status = j < numCompleted - 1 ? 'approved' : rand(['approved', 'pending_approval'])
      await PermanentLesson.create({
        studentId: st._id, tutorId: tutor._id, curriculumItemId: pool[j]._id,
        completedDate: daysAgo(randN(1, 150)), status,
        submittedBy: tutorUsers[td.tutor]._id,
        approvedBy: status === 'approved' ? qci._id : undefined,
        approvedAt: status === 'approved' ? daysAgo(randN(0, 5)) : undefined,
        rejectionReason: '', notes: rand(['Good memorization', 'Accurate recitation', 'Passed with minimal errors', '']),
      })
      permCount++
    }
  }
  console.log(`   ${permCount} permanent lessons`)

  // ════════════════════════════════════════
  // 11. TUTOR ATTENDANCE (90 days)
  // ════════════════════════════════════════
  console.log('\n11. Tutor Attendance')
  let attCount = 0
  for (const tutor of tutors) {
    for (let d = 90; d >= 0; d--) {
      const date = daysAgo(d)
      if (date.getDay() === 0 || date.getDay() === 6) continue
      const present = Math.random() < 0.88
      await TutorAttendance.create({
        tutorId: tutor._id, date,
        checkInAt: present ? new Date(date.getTime() + randN(0, 15) * 60000) : undefined,
        checkOutAt: present ? new Date(date.getTime() + randN(4, 8) * 3600000) : undefined,
        totalHours: present ? randN(4, 8) : 0,
        status: present ? 'present' : rand(['absent', 'partial']),
      })
      attCount++
    }
  }
  console.log(`   ${attCount} records`)

  // ════════════════════════════════════════
  // 12. ADMISSIONS (8 — mix of statuses)
  // ════════════════════════════════════════
  console.log('\n12. Admissions')
  const admNames = ['Bilal Rehman', 'Noor Fatima', 'Hamza Tariq', 'Sumaya Ahmed', 'Zain Ul Abideen', 'Huda Khan', 'Owais Raza', 'Iqra Hassan']
  const admStatuses = ['pending', 'pending', 'pending', 'approved', 'approved', 'approved', 'rejected', 'approved']
  for (let i = 0; i < admNames.length; i++) {
    await AdmissionApplication.create({
      studentName: admNames[i], parentsName: rand(['Abdul Rashid', 'Muhammad Tariq', 'Zahid Ahmed', 'Khalid Khan']),
      dob: new Date(2013 + (i % 5), i % 12, (i % 28) + 1), country: rand(['Pakistan', 'UK', 'USA', 'Canada']),
      timezone: rand(['Asia/Karachi', 'Europe/London', 'America/New_York']),
      guardians: [{ relation: 'father', name: rand(['Abdul Rashid', 'Muhammad Tariq']), phone: `+9230${randN(1000000, 99999999)}`, isWhatsappRecipient: true }],
      whatsappNumber: `+9230${randN(1000000, 99999999)}`, courseLabels: [rand(['nazra', 'hifz', 'qaida', 'tajweed'])],
      placementLevel: rand(['beginning', 'qaida_basic']), sect: 'sunni',
      heardFrom: rand(['Social Media', 'Friend', 'Google', 'WhatsApp Group']),
      status: admStatuses[i],
      reviewedBy: admStatuses[i] !== 'pending' ? admin._id : undefined,
      reviewedAt: admStatuses[i] !== 'pending' ? daysAgo(randN(1, 10)) : undefined,
      reviewNotes: admStatuses[i] === 'rejected' ? 'Age requirement not met' : admStatuses[i] === 'approved' ? 'Welcome to Hidaya!' : '',
    })
  }
  console.log(`   ${admNames.length} applications`)

  // ════════════════════════════════════════
  // 13. ASSESSMENTS (3 rounds for all students)
  // ════════════════════════════════════════
  console.log('\n13. Assessments')
  const template = await AssessmentTemplate.create({
    name: 'Monthly Quran Assessment', active: true,
    sections: [
      { key: 'recitation', label: 'Recitation Quality', fields: [
        { key: 'fluency', label: 'Fluency', type: 'rating', required: true },
        { key: 'tajweed_accuracy', label: 'Tajweed Accuracy', type: 'rating', required: true },
        { key: 'makhraj', label: 'Makhraj', type: 'rating' },
      ]},
      { key: 'memorization', label: 'Memorization', fields: [
        { key: 'retention', label: 'Retention Level', type: 'scale', required: true },
        { key: 'speed', label: 'Recall Speed', type: 'select', options: ['Slow', 'Average', 'Fast', 'Excellent'] },
      ]},
      { key: 'behavior', label: 'Behavior & Attitude', fields: [
        { key: 'attentiveness', label: 'Attentiveness', type: 'rating' },
        { key: 'notes', label: 'Examiner Notes', type: 'text' },
      ]},
    ],
    createdBy: qci._id,
  })
  let assessCount = 0
  for (const st of activeStudents) {
    // 3 assessments per student over 3 months
    for (let round = 0; round < 3; round++) {
      const score = randN(55, 98)
      await Assessment.create({
        studentId: st._id, templateId: template._id, date: daysAgo(round * 30 + randN(1, 10)),
        testTeacherId: rand(tutors)._id, regularTeacherId: tutors[STUDENTS[students.indexOf(st)].tutor]._id,
        attendance: 'present', scope: rand(['qaida', 'quran', 'hifz', 'general']),
        responses: [
          { fieldKey: 'fluency', value: randN(2, 5) }, { fieldKey: 'tajweed_accuracy', value: randN(2, 5) },
          { fieldKey: 'makhraj', value: randN(2, 5) }, { fieldKey: 'retention', value: randN(3, 10) },
          { fieldKey: 'speed', value: rand(['Average', 'Fast', 'Excellent']) }, { fieldKey: 'attentiveness', value: randN(3, 5) },
        ],
        overallScore: score,
        examinerNotes: rand(['Good improvement from last month', 'Needs revision on last para', 'Excellent performance', 'Shows great potential', 'Very consistent recitation']),
        conductedBy: qci._id,
      })
      assessCount++
    }
  }
  console.log(`   ${assessCount} assessments (3 per student)`)

  // ════════════════════════════════════════
  // 14. NOTICES & COMPLAINTS
  // ════════════════════════════════════════
  console.log('\n14. Notices & Complaints')
  const notices = [
    'Ramadan schedule: Classes shifted to evening slots starting next week',
    'Monthly assessment for all Hifz students this Saturday at 10 AM',
    'New curriculum items added for Tajweed — please review before Monday',
    'Parent-teacher meeting scheduled for Wednesday 5 PM',
    'Reminder: Submit all pending lesson records by Friday',
    'Congratulations to the Hifz batch on completing Para 15!',
  ]
  for (let i = 0; i < notices.length; i++) {
    await Notice.create({
      type: i < 3 ? 'teacher' : 'student', category: rand(['permanent', 'urgent', 'temporary', 'information']),
      message: notices[i], severity: i === 0 ? 'urgent' : 'info',
      active: true, createdBy: coord._id, createdAt: daysAgo(randN(0, 20)),
    })
  }
  const complaints = [
    { text: 'Class was cancelled without prior notice last Tuesday', resolved: true },
    { text: 'Student reports audio quality issues during online classes', resolved: true },
    { text: 'Parent concerned about pace of Quran reading progress', resolved: false },
    { text: 'Request for teacher change due to scheduling conflict', resolved: false },
  ]
  for (let i = 0; i < complaints.length; i++) {
    await Complaint.create({
      date: daysAgo(randN(1, 25)), representative: rand(['principal', 'coordinator']),
      studentId: students[i % students.length]._id,
      againstTutorId: i === 0 ? tutors[0]._id : undefined,
      complainant: rand(['father', 'mother']), text: complaints[i].text,
      visibility: 'all_staff', status: complaints[i].resolved ? 'resolved' : 'open',
      createdBy: coord._id,
      resolvedBy: complaints[i].resolved ? admin._id : undefined,
      resolution: complaints[i].resolved ? 'Issue addressed. Schedule adjusted.' : '',
    })
  }
  console.log(`   ${notices.length} notices, ${complaints.length} complaints`)

  // ════════════════════════════════════════
  // 15. INVOICES (4 months x 10 students)
  // ════════════════════════════════════════
  console.log('\n15. Invoices')
  let invCount = 0
  for (const st of students) {
    for (let m = 0; m < 4; m++) {
      const status = m === 0 ? rand(['draft', 'sent']) : rand(['paid', 'paid', 'paid', 'overdue'])
      await Invoice.create({
        invoiceNo: `INV-${new Date().getFullYear()}-${String(invCount + 1).padStart(4, '0')}`,
        studentId: st._id,
        items: [{ description: `Monthly Tuition — ${st.courseLabels[0]}`, amount: st.billing.fee, quantity: 1 }],
        amount: st.billing.fee, currency: st.billing.currency,
        dueDate: daysAgo(-randN(0, 15)), status,
        paidAmount: status === 'paid' ? st.billing.fee : 0,
        createdBy: admin._id, createdAt: monthsAgo(m),
      })
      invCount++
    }
  }
  console.log(`   ${invCount} invoices`)

  // ════════════════════════════════════════
  // 16. SALARY RECORDS (6 months x 4 tutors)
  // ════════════════════════════════════════
  console.log('\n16. Salary Records & Increments')
  const now = new Date()
  let salCount = 0, incCount = 0
  for (const tutor of tutors) {
    for (let m = 5; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1)
      const base = tutor.salary.baseAmount
      const ded = Math.random() < 0.2 ? randN(500, 2000) : 0
      const bon = Math.random() < 0.25 ? randN(1000, 3000) : 0
      await SalaryRecord.create({
        tutorId: tutor._id, month: d.getMonth() + 1, year: d.getFullYear(),
        baseAmount: base, currency: 'PKR',
        deductions: ded > 0 ? [{ reason: 'Late attendance', amount: ded }] : [], totalDeductions: ded,
        bonuses: bon, netPayable: base - ded + bon,
        presentDays: randN(20, 25), absentDays: randN(0, 3), totalHours: randN(100, 160),
        status: m === 0 ? 'draft' : rand(['finalized', 'paid', 'paid']),
        generatedBy: admin._id,
      })
      salCount++
    }
    // 2 increments per tutor
    let prevAmt = Math.round(tutor.salary.baseAmount * 0.75)
    for (let j = 0; j < 2; j++) {
      const newAmt = j === 1 ? tutor.salary.baseAmount : Math.round(prevAmt * 1.15)
      await SalaryIncrement.create({
        tutorId: tutor._id, previousAmount: prevAmt, newAmount: newAmt,
        incrementAmount: newAmt - prevAmt, incrementPercentage: Math.round(((newAmt - prevAmt) / prevAmt) * 100),
        currency: 'PKR', effectiveDate: monthsAgo((2 - j) * 6),
        reason: rand(['Annual performance review', 'Merit-based increment', 'Completion of 1 year']),
        approvedBy: admin._id,
      })
      prevAmt = newAmt
      incCount++
    }
  }
  console.log(`   ${salCount} salary records, ${incCount} increments`)

  // ════════════════════════════════════════
  // 17. CERTIFICATES (mix of approved + pending)
  // ════════════════════════════════════════
  console.log('\n17. Certificates')
  const certData = [
    { si: 0, type: 'qaida_completion', title: 'Certificate of Qaida Completion', design: 'classic', status: 'approved' },
    { si: 1, type: 'tajweed_completion', title: 'Certificate of Tajweed Mastery', design: 'modern', status: 'approved' },
    { si: 2, type: 'hifz_completion', title: 'Certificate of Hifz Achievement', design: 'sapphire', status: 'approved' },
    { si: 3, type: 'qaida_completion', title: 'Certificate of Qaida Completion', design: 'ornate', status: 'approved' },
    { si: 4, type: 'course_completion', title: 'Certificate of Course Completion', design: 'emerald', status: 'approved' },
    { si: 0, type: 'assessment_excellence', title: 'Certificate of Academic Excellence', design: 'crimson', status: 'approved' },
    { si: 5, type: 'attendance_excellence', title: 'Certificate of Outstanding Attendance', design: 'noir', status: 'pending' },
    { si: 6, type: 'hifz_completion', title: 'Certificate of Hifz Achievement', design: 'minimal', status: 'pending' },
    { si: 7, type: 'qaida_completion', title: 'Certificate of Qaida Completion', design: 'classic', status: 'pending' },
  ]
  for (const cd of certData) {
    await Certificate.create({
      studentId: students[cd.si]._id, type: cd.type, title: cd.title,
      details: `In recognition of outstanding achievement and dedication to learning at Hidaya Online Academy.`,
      templateDesign: cd.design, status: cd.status,
      submittedBy: tutorUsers[STUDENTS[cd.si].tutor]._id,
      issuedBy: cd.status === 'approved' ? admin._id : tutorUsers[STUDENTS[cd.si].tutor]._id,
      approvedBy: cd.status === 'approved' ? admin._id : undefined,
      approvedAt: cd.status === 'approved' ? daysAgo(randN(1, 30)) : undefined,
      issuedDate: cd.status === 'approved' ? daysAgo(randN(1, 60)) : new Date(),
    })
  }
  console.log(`   ${certData.length} certificates (${certData.filter(c => c.status === 'approved').length} approved, ${certData.filter(c => c.status === 'pending').length} pending)`)

  // ════════════════════════════════════════
  // 18. CHAT
  // ════════════════════════════════════════
  console.log('\n18. Chat')
  const allUsers = [superAdmin, admin, principal, coord, qci, qcm, ...tutorUsers, ...studentUsers]
  const staffIds = [superAdmin, admin, principal, coord, qci, qcm, ...tutorUsers].map(u => u._id)

  const chDefs = [
    { name: 'General', desc: 'General discussion for all staff', label: 'general' },
    { name: 'Announcements', desc: 'Official announcements', label: 'announcement' },
    { name: 'Tutors Lounge', desc: 'Tutor-only chat', label: 'staff' },
  ]
  for (const ch of chDefs) {
    const thread = await ChatThread.create({ type: 'channel', name: ch.name, description: ch.desc, label: ch.label, createdBy: admin._id, participants: staffIds, lastMessageAt: daysAgo(0) })
    const msgs = ['Assalamu Alaikum everyone!', 'Reminder: Please submit attendance by 5 PM.', 'JazakAllah Khair for a productive week.', 'New curriculum updates are live.', 'Is anyone available to cover the 3 PM slot tomorrow?']
    for (let m = 0; m < msgs.length; m++) {
      await Message.create({ threadId: thread._id, senderId: rand(staffIds), body: msgs[m], format: 'plain', createdAt: daysAgo(randN(0, 5)) })
    }
  }
  // 4 DMs
  for (let i = 0; i < 4; i++) {
    const p1 = allUsers[i], p2 = allUsers[i + 4]
    const thread = await ChatThread.create({ type: 'dm', createdBy: p1._id, participants: [p1._id, p2._id], lastMessageAt: daysAgo(randN(0, 3)) })
    const dms = ['Assalamu Alaikum, can we discuss the student progress?', 'Wa Alaikum Assalam, sure. When are you free?', 'After Zuhr today?', 'That works, JazakAllah.']
    for (let m = 0; m < dms.length; m++) {
      await Message.create({ threadId: thread._id, senderId: m % 2 === 0 ? p1._id : p2._id, body: dms[m], format: 'plain', createdAt: daysAgo(randN(0, 2)) })
    }
  }
  console.log(`   3 channels, 4 DMs`)

  // ════════════════════════════════════════
  // 19. NOTIFICATIONS
  // ════════════════════════════════════════
  console.log('\n19. Notifications')
  const notifPool = [
    { type: 'admission', title: 'New Admission', body: 'A new student has applied.' },
    { type: 'lesson_approved', title: 'Lesson Approved', body: 'Your submission was approved.' },
    { type: 'class_start', title: 'Class Starting', body: 'Your class starts in 10 minutes.' },
    { type: 'notice', title: 'New Notice', body: 'A new notice has been posted.' },
    { type: 'system', title: 'System Update', body: 'Portal updated with new features.' },
    { type: 'assignment', title: 'New Assignment', body: 'You have been assigned a new student.' },
    { type: 'certificate_issued', title: 'Certificate Issued!', body: 'Congratulations! You received a certificate.' },
  ]
  for (let i = 0; i < 30; i++) {
    const n = notifPool[i % notifPool.length]
    await Notification.create({
      userId: allUsers[i % allUsers.length]._id, type: n.type, title: n.title, body: n.body,
      readAt: Math.random() < 0.5 ? daysAgo(randN(0, 3)) : undefined, createdAt: daysAgo(randN(0, 14)),
    })
  }
  console.log(`   30 notifications`)

  // ════════════════════════════════════════
  // CREDENTIALS FILE
  // ════════════════════════════════════════
  const credLines = [
    '# Hidaya Portal — Client Demo Credentials', '',
    `> Password for all accounts: \`${PASSWORD}\``, `> Generated: ${new Date().toISOString().split('T')[0]}`, '',
    '## Staff', '', '| Role | Email | Name |', '|------|-------|------|',
    ...creds.filter(c => !c.roles.includes('tutor') && !c.roles.includes('student')).map(c => `| ${c.roles} | ${c.email} | ${c.name} |`),
    '', '## Tutors', '', '| Email | Name |', '|-------|------|',
    ...creds.filter(c => c.roles === 'tutor').map(c => `| ${c.email} | ${c.name} |`),
    '', '## Students', '', '| Email | Name |', '|-------|------|',
    ...creds.filter(c => c.roles === 'student').map(c => `| ${c.email} | ${c.name} |`), '',
  ]
  fs.writeFileSync(path.join(__dirname, 'DEMO_CREDENTIALS.md'), credLines.join('\n'))

  // ════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════
  console.log('\n' + '═'.repeat(50))
  console.log('  ✅ CLIENT DEMO SEED COMPLETE')
  console.log('═'.repeat(50))
  const counts = [
    ['Roles', Role], ['Users', User], ['Students', Student], ['Tutors', TutorProfile],
    ['Families', Family], ['Assignments', Assignment], ['Slots', ClassSlot], ['Sessions', ClassSession],
    ['Lessons', LessonEntry], ['Permanent', PermanentLesson], ['Curriculum', CurriculumItem],
    ['Assessments', Assessment], ['Admissions', AdmissionApplication], ['Attendance', TutorAttendance],
    ['Notices', Notice], ['Complaints', Complaint], ['Invoices', Invoice],
    ['Salary', SalaryRecord], ['Increments', SalaryIncrement], ['Certificates', Certificate],
    ['Threads', ChatThread], ['Messages', Message], ['Notifications', Notification],
  ]
  for (const [label, Model] of counts) {
    console.log(`  ${label.padEnd(16)} ${await Model.countDocuments()}`)
  }
  console.log('═'.repeat(50))

  await mongoose.disconnect()
  console.log('\nCredentials → DEMO_CREDENTIALS.md')
}

seed().catch(err => { console.error('❌ Seed failed:', err); process.exit(1) })
