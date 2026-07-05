# Hidaya Online — Backend API

Express + MongoDB REST API and real-time server for **Hidaya Online**, an online Quran-learning academy. It powers the public marketing site's forms/payments and the internal staff **Portal** (RBAC-gated management system for students, tutors, scheduling, lessons, finance/payroll, and communication).

- **Runtime:** Node.js (ES modules), Express 4
- **Database:** MongoDB via Mongoose 8
- **Auth:** JWT (two separate systems — admin & portal), bcrypt, TOTP MFA (otplib)
- **Real-time:** Socket.IO (`/portal` namespace) + a legacy `/ws/export` WebSocket
- **Integrations:** Mastercard Payment Gateway (REST v73), Nodemailer SMTP, AWS S3, geoip-lite

---

## Quick start (local)

```bash
npm install
cp .env.example .env      # then fill in the values (see Environment below)
npm run seed              # create the initial admin user from ADMIN_EMAIL / ADMIN_PASSWORD
npm run dev               # node --watch index.js → http://localhost:5000
```

Scripts:

| Script | What it does |
|---|---|
| `npm run dev` | Start with `node --watch` (auto-restart on change) |
| `npm start` | Production start (`node index.js`) |
| `npm run seed` | Seed the initial admin account |

---

## Environment variables

Set these in `.env` locally and in your host's dashboard (Render) in production.

### Required

| Key | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Secret for signing admin **and** portal JWTs |
| `MFA_ENCRYPTION_KEY` | **64-char hex string (32 bytes)** used to encrypt TOTP secrets at rest. **Required for MFA and the password-reset-with-MFA flow.** Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The server starts without it, but MFA endpoints throw until it's set. |
| `FRONTEND_URL` | Allowed CORS origin **and** base URL used in emails (e.g. reset links, payment links). Must match the deployed frontend domain. |
| `PORT` | HTTP port (Render injects this) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Credentials for the seeded admin account |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | SMTP transport for all outgoing email |
| `NOTIFY_EMAIL` | Address that receives admin notifications (new enrollments, payments) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET` | S3 storage for blog images / uploads |
| `MC_MERCHANT_ID`, `MC_API_USERNAME`, `MC_API_PASSWORD`, `MC_GATEWAY_URL` | Mastercard Payment Gateway (checkout sessions & order lookups) |

### Optional

| Key | Default | Description |
|---|---|---|
| `PRESIGN_EXPIRES` | `900` | S3 pre-signed URL lifetime (seconds) |

> **Deploy note:** Since the last deployment, the only **new required** variable is `MFA_ENCRYPTION_KEY`. If MFA was never previously enrolled in production, setting a fresh key is safe. Do **not** change an existing key once users have enrolled MFA — their stored secrets were encrypted with the old key and won't decrypt.

---

## Architecture

### Two auth systems
1. **Admin** (`middleware/auth.js`) — verifies JWT, sets `req.adminId`. Token stored client-side as `admin_token`. Routes under `/api/auth`, `/api/payments`, `/api/students`, etc.
2. **Portal** (`middleware/portalAuth.js`) — verifies JWT with `type: 'portal'`, loads the `User` with populated roles, and builds `req.userPermissions` (a `Set`). Token stored as `portal_token`. Supports TOTP MFA. Routes under `/api/portal/*`.

### RBAC (portal)
- Permissions are flat `domain.action` strings defined in `config/permissions.js` (e.g. `student.read`, `salary.manage`, `advance.manage`, `liveboard.view`).
- `requirePermission(...perms)` middleware enforces that all listed permissions are present.
- Default roles: `super_admin`, `admin`, `principal`, `coordinator`, `qci`, `qcm`, `tutor`, `student`.
- **Role permissions auto-sync on startup** (`index.js`): if a system role's permission count differs from `DEFAULT_ROLE_PERMISSIONS`, it's updated — so adding a permission to a role in code takes effect on the next restart.

### Route groups (all under `/api`)
- **Public/admin:** `/auth`, `/payments`, `/enrollments`, `/payment-links`, `/discount-codes`, `/plans`, `/students`, `/blogs`, `/subscribers`, `/uploads`, `/export`, `/logs`
- **Portal:** `/portal/auth`, `/portal/users`, `/portal/roles`, `/portal/students`, `/portal/tutors`, `/portal/admissions`, `/portal/curriculum`, `/portal/assignments`, `/portal/schedule`, `/portal/attendance`, `/portal/lessons`, `/portal/chat`, `/portal/assessments`, `/portal/notices`, `/portal/finance`, `/portal/advances`, `/portal/expenses`, `/portal/leaves`, `/portal/reports`, `/portal/leads`, `/portal/dashboard`, `/portal/notifications`, `/portal/billing` (payments/links/discount-codes/plans)

### Real-time (Socket.IO — `/portal` namespace)
Authenticated via JWT handshake. On connect a socket joins `user:<id>`, `role:<key>` rooms, and `live-board` (if the user has `liveboard.view`). Emit helpers in `config/socket.js`:
- `emitToUser`, `emitToRole`, `emitToAll`, `emitToLiveBoard`.
- Events the client listens for: `notification` (drives the bell), `new_message`, `notice_changed`, `live_board_changed`, `certificate_awarded`, `badge_awarded`, `employee_of_month`, typing/presence.
- **Any code that creates a `Notification` should also emit `notification` to the recipient** so the bell updates live (see `createNotification` in `portalNotificationController.js`).

### Services
- `services/mastercard.js` — checkout session creation + order retrieval (Basic auth, REST v73).
- `services/mailer.js` — Nodemailer transport with branded HTML templates: enrollment/payment/admission notifications, **password-reset OTP**, **student portal welcome (credentials)**, invoices (with discount breakdown).

### Background jobs
- **Payment cleanup** — marks pending payments older than 1h as expired (on startup + hourly).
- **Log TTL** — MongoDB TTL index auto-deletes logs after 90 days.

### Key models
`Admin`, `User`, `Role`, `Student`, `TutorProfile`, `StaffProfile`, `Family` · `ClassSlot`, `ClassSession`, `LessonEntry`, `CurriculumItem`, `Assessment`, `TutorAttendance` · `Payment`, `PaymentLink`, `Plan`, `DiscountCode`, `Invoice`, `SalaryRecord`, `SalaryIncrement`, `Advance`, `Expense`, `Enrollment`, `AdmissionApplication` · `ChatThread`, `Message`, `Notice`, `Complaint`, `Notification` · `BlogPost`, `Subscriber`, `Log`

---

## Notable flows

- **Portal login + MFA:** `POST /portal/auth/login`. If the account has MFA and no `totpCode`, responds `{ mfaRequired: true }`; a valid code then returns the JWT.
- **Password reset:** `POST /portal/auth/forgot-password` → if MFA is on, a valid TOTP is required *before* the 6-digit OTP is emailed (anti-enumeration; only `mfaRequired` is ever leaked). `POST /portal/auth/reset-password` verifies the hashed OTP (10-min expiry, 5 attempts) and sets the new password.
- **Student portal account:** creating a student can optionally create a linked `User` (student role) and email temporary credentials.
- **Tutor payroll:** set a tutor's base salary → `GET /portal/finance/salary/roster?month&year` lists every active tutor merged with their record → `POST /portal/finance/salary/generate` builds a `SalaryRecord` (attendance-based deductions + auto-deducts active monthly `Advance` installments + overtime/bonuses) → mark paid → receipt.
- **Live classes:** tutor `POST /portal/schedule/sessions/:id/start` → visible on the `live-board` (oversight roles) and via `GET /portal/schedule/my-live` (tutor's own, for the overrun reminder) → `complete` ends it.

---

## Deployment (Render)

1. Web Service → build `npm install`, start `npm start`.
2. Set all **Required** env vars above. Ensure `FRONTEND_URL` matches the deployed frontend origin (CORS + email links).
3. Add the new `MFA_ENCRYPTION_KEY` (64-char hex).
4. On boot, role permissions auto-sync; the payment-cleanup job starts.
