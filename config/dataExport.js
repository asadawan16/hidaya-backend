// What the Hidaya portal's bulk "Data Export" (disaster-recovery backup) writes.
// One CSV per collection, grouped into folders by area. The portal is the system
// of record now, so this is everything it runs on — and deliberately NOT the
// legacy admin-portal data (see EXCLUDED below).
//
// Adding a model that holds real portal data? Add it here too, or it silently
// never gets backed up. scripts/smoke-data-export.mjs fails if a model in
// models/ is in neither list.
import User from '../models/User.js'
import Role from '../models/Role.js'
import Student from '../models/Student.js'
import StudentStatusHistory from '../models/StudentStatusHistory.js'
import StudentRelationship from '../models/StudentRelationship.js'
import Family from '../models/Family.js'
import TutorProfile from '../models/TutorProfile.js'
import StaffProfile from '../models/StaffProfile.js'
import Enrollment from '../models/Enrollment.js'
import AdmissionApplication from '../models/AdmissionApplication.js'
import DemoTrial from '../models/DemoTrial.js'
import ClassSlot from '../models/ClassSlot.js'
import ClassSession from '../models/ClassSession.js'
import ScheduleConfig from '../models/ScheduleConfig.js'
import ShiftConfig from '../models/ShiftConfig.js'
import CurriculumItem from '../models/CurriculumItem.js'
import Assignment from '../models/Assignment.js'
import TutorChangeRequest from '../models/TutorChangeRequest.js'
import LessonEntry from '../models/LessonEntry.js'
import PermanentLesson from '../models/PermanentLesson.js'
import Assessment from '../models/Assessment.js'
import AssessmentTemplate from '../models/AssessmentTemplate.js'
import TutorAttendance from '../models/TutorAttendance.js'
import LeaveRequest from '../models/LeaveRequest.js'
import Badge from '../models/Badge.js'
import Certificate from '../models/Certificate.js'
import EmployeeOfMonth from '../models/EmployeeOfMonth.js'
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import FeePayment from '../models/FeePayment.js'
import Invoice from '../models/Invoice.js'
import Payment from '../models/Payment.js'
import PaymentLink from '../models/PaymentLink.js'
import Plan from '../models/Plan.js'
import DiscountCode from '../models/DiscountCode.js'
import PaymentSettings from '../models/PaymentSettings.js'
import SalaryRecord from '../models/SalaryRecord.js'
import SalaryIncrement from '../models/SalaryIncrement.js'
import StaffSalaryIncrement from '../models/StaffSalaryIncrement.js'
import Advance from '../models/Advance.js'
import Expense from '../models/Expense.js'
import ChatThread from '../models/ChatThread.js'
import Message from '../models/Message.js'
import Notice from '../models/Notice.js'
import Complaint from '../models/Complaint.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import ClassLink from '../models/ClassLink.js'
import ClassLinkSettings from '../models/ClassLinkSettings.js'
import StudentClassLink from '../models/StudentClassLink.js'

// `omit` = dotted paths never written to the file. Credentials only — a backup
// that leaks password hashes or MFA secrets is a second incident, and after a
// restore people simply reset their password / re-enrol MFA.
export const EXPORT_COLLECTIONS = [
  { folder: 'people', file: 'users', label: 'Portal users', model: User, omit: ['password', 'mfa.secretEnc', 'passwordReset', 'pushTokens'] },
  { folder: 'people', file: 'roles', label: 'Roles & permissions', model: Role },
  { folder: 'people', file: 'students', label: 'Students', model: Student },
  { folder: 'people', file: 'student-status-history', label: 'Student status history', model: StudentStatusHistory },
  { folder: 'people', file: 'student-relationships', label: 'Student relationships', model: StudentRelationship },
  { folder: 'people', file: 'families', label: 'Families', model: Family },
  { folder: 'people', file: 'tutors', label: 'Tutor profiles', model: TutorProfile },
  { folder: 'people', file: 'staff-profiles', label: 'Staff profiles', model: StaffProfile },

  { folder: 'admissions', file: 'leads-enrollments', label: 'Leads / enrollments', model: Enrollment },
  { folder: 'admissions', file: 'admission-applications', label: 'Admission applications', model: AdmissionApplication },
  { folder: 'admissions', file: 'demo-trials', label: 'Demo trials', model: DemoTrial },

  { folder: 'academic', file: 'class-slots', label: 'Class slots', model: ClassSlot },
  { folder: 'academic', file: 'class-sessions', label: 'Class sessions', model: ClassSession },
  { folder: 'academic', file: 'schedule-config', label: 'Schedule settings', model: ScheduleConfig },
  { folder: 'academic', file: 'shift-config', label: 'Shift settings', model: ShiftConfig },
  { folder: 'academic', file: 'curriculum-items', label: 'Curriculum', model: CurriculumItem },
  { folder: 'academic', file: 'assignments', label: 'Tutor assignments', model: Assignment },
  { folder: 'academic', file: 'tutor-change-requests', label: 'Tutor change requests', model: TutorChangeRequest },
  { folder: 'academic', file: 'lesson-entries', label: 'Daily lessons', model: LessonEntry },
  { folder: 'academic', file: 'permanent-lessons', label: 'Permanent lessons', model: PermanentLesson },
  { folder: 'academic', file: 'assessments', label: 'Assessments', model: Assessment },
  { folder: 'academic', file: 'assessment-templates', label: 'Assessment templates', model: AssessmentTemplate },

  { folder: 'hr', file: 'attendance', label: 'Attendance (tutors & staff)', model: TutorAttendance },
  { folder: 'hr', file: 'leave-requests', label: 'Leave requests', model: LeaveRequest },
  { folder: 'hr', file: 'badges', label: 'Badges', model: Badge },
  { folder: 'hr', file: 'certificates', label: 'Certificates', model: Certificate },
  { folder: 'hr', file: 'employee-of-month', label: 'Employee of the month', model: EmployeeOfMonth },

  { folder: 'finance', file: 'student-fee-records', label: 'Fee records', model: StudentFeeRecord },
  { folder: 'finance', file: 'fee-payments', label: 'Fee payments', model: FeePayment },
  { folder: 'finance', file: 'invoices', label: 'Invoices', model: Invoice },
  { folder: 'finance', file: 'payments', label: 'Online payments', model: Payment },
  { folder: 'finance', file: 'payment-links', label: 'Payment links', model: PaymentLink },
  { folder: 'finance', file: 'plans', label: 'Plans', model: Plan },
  { folder: 'finance', file: 'discount-codes', label: 'Discount codes', model: DiscountCode },
  { folder: 'finance', file: 'payment-settings', label: 'Payment settings', model: PaymentSettings },
  { folder: 'finance', file: 'salary-records', label: 'Salary records', model: SalaryRecord },
  { folder: 'finance', file: 'salary-increments', label: 'Tutor salary increments', model: SalaryIncrement },
  { folder: 'finance', file: 'staff-salary-increments', label: 'Staff salary increments', model: StaffSalaryIncrement },
  { folder: 'finance', file: 'advances', label: 'Advances', model: Advance },
  { folder: 'finance', file: 'expenses', label: 'Expenses', model: Expense },

  { folder: 'communication', file: 'chat-threads', label: 'Chat threads', model: ChatThread },
  { folder: 'communication', file: 'chat-messages', label: 'Chat messages', model: Message },
  { folder: 'communication', file: 'notices', label: 'Notices', model: Notice },
  { folder: 'communication', file: 'complaints', label: 'Complaints', model: Complaint },
  { folder: 'communication', file: 'whatsapp-messages', label: 'WhatsApp messages', model: WhatsappMessage },
  { folder: 'communication', file: 'class-links', label: 'Class links board', model: ClassLink },
  { folder: 'communication', file: 'class-link-settings', label: 'Class links settings', model: ClassLinkSettings },
  { folder: 'communication', file: 'student-class-links', label: 'Student class pages', model: StudentClassLink },
]

// Left out on purpose — listed in the archive's README so nobody wonders.
export const EXCLUDED = [
  { model: 'Admin', reason: 'legacy admin-portal login accounts' },
  { model: 'BlogPost', reason: 'legacy admin-portal blog content' },
  { model: 'Subscriber', reason: 'legacy admin-portal newsletter list' },
  { model: 'Log', reason: 'activity log; expires after 90 days' },
  { model: 'Notification', reason: 'in-app pings; regenerated by activity' },
  { model: 'StripeEvent', reason: 'webhook de-duplication ledger; expires after 30 days' },
  { model: 'WhatsappReminderLog', reason: 'reminder send de-duplication log' },
  { model: 'WhatsappConnection', reason: 'holds the encrypted WhatsApp API token; reconnect from the portal' },
  { model: 'DataExport', reason: 'the history of these exports' },
]

// The reminder pops when the newest export is older than this.
export const EXPORT_REMINDER_DAYS = 7
