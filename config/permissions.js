// Permission catalog — single source of truth for RBAC
// Format: domain.action (flat strings, stored in Role.permissions arrays)

export const PERMISSIONS = {
  // Student management
  student: ['student.read', 'student.create', 'student.update', 'student.delete', 'student.approve'],

  // Enrollment / admissions
  enrollment: ['enrollment.read', 'enrollment.create', 'enrollment.update'],

  // Tutor management
  tutor: ['tutor.read', 'tutor.create', 'tutor.update', 'tutor.delete'],

  // Assignments (tutor ↔ student)
  assignment: ['assignment.read', 'assignment.manage'],

  // Lessons (daily + permanent)
  lesson: ['lesson.read', 'lesson.log', 'lesson.approve'],

  // Assessments / exams
  assessment: ['assessment.read', 'assessment.create', 'assessment.template_manage'],

  // Scheduling / classes
  schedule: ['schedule.read', 'schedule.manage'],

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

  // Salary
  salary: ['salary.read', 'salary.manage'],

  // Blogs
  blog: ['blog.read', 'blog.create', 'blog.update', 'blog.delete'],

  // Subscribers / newsletter
  subscriber: ['subscriber.read', 'subscriber.delete', 'subscriber.send'],

  // Notices & complaints
  notice: ['notice.read', 'notice.create', 'notice.manage'],
  complaint: ['complaint.read', 'complaint.create'],

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

  // Advances / loans
  advance: ['advance.read', 'advance.manage'],

  // Leave management
  leave: ['leave.read', 'leave.request', 'leave.review'],

  // Student education progress (read-only aggregated view; NOT the student's own /my-progress)
  studentProgress: ['student_progress.read'],

  // Manual fee management (yearly grid, mark months received/pending, link payments)
  fee: ['fee.read', 'fee.manage'],
}

export const ALL_PERMISSIONS = Object.values(PERMISSIONS).flat()

// Default role → permission mappings
export const DEFAULT_ROLE_PERMISSIONS = {
  super_admin: ALL_PERMISSIONS,

  admin: ALL_PERMISSIONS.filter(p => !['role.delete'].includes(p)),

  principal: [
    'student.read', 'student.approve', 'enrollment.read', 'enrollment.update',
    'tutor.read', 'assignment.read',
    'lesson.read', 'assessment.read',
    'notice.read', 'notice.create', 'notice.manage',
    'complaint.read', 'complaint.create',
    'report.read', 'report.generate',
    'liveboard.view', 'chat.use',
    'schedule.read',
    'finance.read', 'finance.manage',
    'family.read',
    'expense.read',
    'award.read',
    'advance.read',
    'badge.read', 'badge.approve',
    'leave.read', 'leave.review',
    'student_progress.read',
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
    'finance.read',
    'family.read', 'family.create', 'family.update',
    'expense.read',
    'award.read',
    'badge.read',
    'advance.read',
    'leave.read', 'leave.review',
    'student_progress.read',
  ],

  qci: [
    'student.read', 'tutor.read',
    'lesson.read', 'lesson.approve',
    'assessment.read', 'assessment.create', 'assessment.template_manage',
    'notice.read', 'notice.create',
    'complaint.read', 'complaint.create',
    'report.read',
    'certificate.read', 'certificate.approve',
    'badge.read', 'badge.approve',
    'liveboard.view', 'chat.use',
    'leave.read', 'leave.review',
    'student_progress.read', 'fee.read', 'fee.manage',
  ],

  qcm: [
    'student.read', 'tutor.read',
    'lesson.read',
    'assessment.read',
    'notice.read',
    'complaint.read',
    'badge.read', 'badge.approve',
    'report.read',
    'liveboard.view', 'chat.use',
    'student_progress.read', 'fee.read', 'fee.manage',
  ],

  tutor: [
    'student.read',
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
    'advance.read',
    'leave.read', 'leave.request',
    'student_progress.read',
  ],

  student: [
    'schedule.read',
    'lesson.read',
    'assessment.read',
    'certificate.read',
    'badge.read',
  ],
}
