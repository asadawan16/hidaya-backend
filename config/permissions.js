// Permission catalog — single source of truth for RBAC
// Format: domain.action (flat strings, stored in Role.permissions arrays)

export const PERMISSIONS = {
  // Student management
  // student.pick — search/select students in pickers (logging lessons, assessments,
  // etc.) WITHOUT the full student directory, detail views, or org-wide counts.
  student: ['student.read', 'student.pick', 'student.create', 'student.update', 'student.delete', 'student.approve', 'student.feedback_admin', 'student.feedback_quality'],

  // Enrollment / admissions
  enrollment: ['enrollment.read', 'enrollment.create', 'enrollment.update'],

  // Tutor management
  // tutor.pick — search/select a tutor in pickers (logging lessons) WITHOUT the
  // Tutors directory tab or org-wide tutor counts.
  tutor: ['tutor.read', 'tutor.pick', 'tutor.create', 'tutor.update', 'tutor.delete'],

  // Assignments (tutor ↔ student)
  assignment: ['assignment.read', 'assignment.manage', 'assignment.request', 'assignment.approve'],

  // Lessons (daily + permanent)
  // lesson.log_only — RESTRICTION permission: holders may log lessons but the daily
  // lessons list on the Lessons page is hidden from them (a just-logged entry shows
  // briefly then blurs). Keeps tutors from browsing lessons there; they review
  // lessons via a student's Progress page instead. Opt-in per role — see
  // RESTRICTION_PERMISSIONS below.
  lesson: ['lesson.read', 'lesson.log', 'lesson.approve', 'lesson.log_only'],

  // Assessments / exams
  assessment: ['assessment.read', 'assessment.create', 'assessment.template_manage'],

  // Scheduling / classes
  // schedule.session_status — edit a session's status/attendance to any valid enum
  // value (late, missed, on-time…). Broader than the super-admin reset-to-scheduled.
  schedule: ['schedule.read', 'schedule.manage', 'schedule.session_status'],

  // Payments
  payment: ['payment.read', 'payment.create', 'payment.update'],

  // Payment links
  paymentLink: ['payment_link.read', 'payment_link.create', 'payment_link.delete', 'payment_link.send'],

  // Plans / pricing
  plan: ['plan.read', 'plan.update'],

  // Discount codes
  discountCode: ['discount_code.read', 'discount_code.create', 'discount_code.update', 'discount_code.delete'],

  // Finances & invoices
  finance: ['finance.read', 'finance.manage'],

  // Revenue analytics dashboard (org-wide income/expense overview — the
  // /portal/revenue page). Separate from finance.* so a role can hold the
  // invoices/salary Finance page without the org-wide revenue breakdown.
  revenue: ['revenue.read'],

  // Salary
  salary: ['salary.read', 'salary.manage'],

  // Staff / HR — management & support employees (non-tutor, non-student portal
  // users). staff.manage covers their HR profile (joining date, designation,
  // department) + base salary + salary increments; staff.read is view-only.
  staff: ['staff.read', 'staff.manage'],

  // Blogs
  blog: ['blog.read', 'blog.create', 'blog.update', 'blog.delete'],

  // Subscribers / newsletter
  subscriber: ['subscriber.read', 'subscriber.delete', 'subscriber.send'],

  // Notices & complaints
  notice: ['notice.read', 'notice.create', 'notice.manage'],
  complaint: ['complaint.read', 'complaint.create', 'complaint.update', 'complaint.delete'],

  // Certificates
  certificate: ['certificate.read', 'certificate.submit', 'certificate.approve'],

  // Reports
  report: ['report.read', 'report.generate'],

  // Live board
  liveboard: ['liveboard.view'],

  // Chat
  chat: ['chat.use'],

  // System logs
  log: ['log.read', 'log.delete'],

  // DB export
  export: ['export.read', 'export.download'],

  // User management (portal)
  user: ['user.read', 'user.create', 'user.update', 'user.delete'],

  // Role management (portal)
  role: ['role.read', 'role.create', 'role.update', 'role.delete'],

  // MFA management
  mfa: ['mfa.enroll', 'mfa.revoke'],

  // Family management
  family: ['family.read', 'family.create', 'family.update', 'family.delete'],

  // WhatsApp reminders
  whatsapp: ['whatsapp.send'],

  // Expense management
  expense: ['expense.read', 'expense.manage'],

  // Badges
  badge: ['badge.read', 'badge.submit', 'badge.approve'],

  // Awards
  award: ['award.read', 'award.manage'],

  // Advances / loans. Held by tutors AND management/support staff — each has its
  // own ledger, and repayments are deducted from whichever salary sheet applies.
  // advance.request lets a person file their own request (the My Advances page).
  advance: ['advance.read', 'advance.manage', 'advance.request'],

  // Leave management
  leave: ['leave.read', 'leave.request', 'leave.review'],

  // Student education progress (read-only aggregated view; NOT the student's own /my-progress)
  studentProgress: ['student_progress.read'],

  // Manual fee management (yearly grid, mark months received/pending, link payments)
  // fee.receivables — gates the Receivables tab + the summary KPI cards on the Fee
  // Management page (super-admin only by default).
  fee: ['fee.read', 'fee.manage', 'fee.receivables'],

  // Demo trial classes (tracking + statuses)
  demo: ['demo.read', 'demo.manage'],

  // Public class links page (/class-links) — the shareable meeting-link board.
  // Super-admin only by default (see the admin exclusion list below); publishing
  // a link exposes a join URL to anyone the page is forwarded to.
  classLink: ['class_link.read', 'class_link.manage'],
}

export const ALL_PERMISSIONS = Object.values(PERMISSIONS).flat()

// "Restriction" permissions invert the usual grant model: their PRESENCE removes
// access rather than granting it (e.g. lesson.log_only hides the lessons list).
// They must be OPT-IN per role, so they are excluded from the all-powerful
// super_admin/admin defaults — otherwise a fresh seed would restrict them.
export const RESTRICTION_PERMISSIONS = ['lesson.log_only']

// Default role → permission mappings
export const DEFAULT_ROLE_PERMISSIONS = {
  super_admin: ALL_PERMISSIONS.filter(p => !RESTRICTION_PERMISSIONS.includes(p)),

  // Admin gets everything except role deletion, the super-admin-only Fee
  // receivables view/KPIs, and the public class-links board (and never the
  // opt-in restriction permissions).
  admin: ALL_PERMISSIONS.filter(p => !['role.delete', 'fee.receivables', 'class_link.read', 'class_link.manage', ...RESTRICTION_PERMISSIONS].includes(p)),

  principal: [
    'student.read', 'student.approve', 'enrollment.read', 'enrollment.update',
    'tutor.read', 'assignment.read',
    'lesson.read', 'assessment.read',
    'notice.read', 'notice.create', 'notice.manage',
    'complaint.read', 'complaint.create', 'complaint.update', 'complaint.delete',
    'report.read', 'report.generate',
    'liveboard.view', 'chat.use',
    'schedule.read',
    'finance.read', 'finance.manage', 'revenue.read',
    'staff.read',
    // Full billing surface (matches the pre-split finance.read+manage access)
    'payment.read', 'payment.create', 'payment.update',
    'payment_link.read', 'payment_link.create', 'payment_link.send', 'payment_link.delete',
    'plan.read', 'plan.update',
    'discount_code.read', 'discount_code.create', 'discount_code.update', 'discount_code.delete',
    'family.read',
    'expense.read',
    'award.read',
    'advance.read', 'advance.request',
    'badge.read', 'badge.approve',
    'leave.read', 'leave.review',
    'student_progress.read',
    'demo.read', 'demo.manage',
  ],

  coordinator: [
    'student.read', 'student.create', 'student.update', 'student.approve',
    'enrollment.read', 'enrollment.update',
    'tutor.read', 'tutor.update',
    'assignment.read', 'assignment.manage',
    'lesson.read', 'assessment.read',
    'schedule.read', 'schedule.manage',
    'notice.read', 'notice.create',
    'complaint.read', 'complaint.create',
    'report.read', 'report.generate',
    'liveboard.view', 'chat.use',
    'whatsapp.send',
    'finance.read', 'revenue.read',
    'staff.read',
    // Read-only billing surface (matches the pre-split finance.read access)
    'payment.read', 'payment_link.read', 'plan.read', 'discount_code.read',
    'family.read', 'family.create', 'family.update',
    'expense.read',
    'award.read',
    'badge.read',
    'advance.read', 'advance.request',
    'leave.read', 'leave.review',
    'student_progress.read',
    'demo.read', 'demo.manage',
  ],

  qci: [
    'student.read', 'tutor.read',
    'assignment.read', 'assignment.request',
    'lesson.read', 'lesson.approve',
    'assessment.read', 'assessment.create', 'assessment.template_manage',
    // QCI oversees the teaching schedule (manages tutors), so gets the full
    // session board + slot management, same surfaces as management roles.
    'schedule.read', 'schedule.manage', 'schedule.session_status',
    'notice.read', 'notice.create',
    'complaint.read', 'complaint.create',
    'report.read',
    'certificate.read', 'certificate.approve',
    'badge.read', 'badge.approve',
    'liveboard.view', 'chat.use',
    'leave.read', 'leave.review',
    'advance.read', 'advance.request',
    'student_progress.read', 'fee.read', 'fee.manage',
    'student.feedback_quality',
  ],

  qcm: [
    'student.read', 'tutor.read',
    'assignment.read', 'assignment.approve',
    'lesson.read',
    'assessment.read',
    'notice.read',
    'complaint.read',
    'badge.read', 'badge.approve',
    'report.read',
    'liveboard.view', 'chat.use',
    'advance.read', 'advance.request',
    'student_progress.read', 'fee.read', 'fee.manage',
    'student.feedback_quality',
  ],

  tutor: [
    // Tutors select students/tutors to log lessons via `student.pick`/`tutor.pick`,
    // which grant the pickers WITHOUT the directories or counts (`*.read`).
    'student.pick', 'tutor.pick',
    'lesson.read', 'lesson.log',
    'assessment.read', 'assessment.create',
    'schedule.read',
    'notice.read',
    'complaint.read',
    'report.read',
    'certificate.read', 'certificate.submit',
    'badge.read', 'badge.submit',
    'chat.use',
    'whatsapp.send',
    'award.read',
    'advance.read', 'advance.request',
    'leave.read', 'leave.request',
    'student_progress.read',
  ],

  student: [
    'schedule.read',
    'lesson.read',
    'assessment.read',
    'certificate.read',
    'badge.read',
    'assignment.request',
    'notice.read',
  ],
}
