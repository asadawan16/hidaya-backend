# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hidaya Online — a full-stack web application for an online Quran learning academy. Monorepo with two independent packages: a React SPA frontend and an Express/MongoDB REST API backend.

This root folder is **not** a git repository — `hidayah-frontend/` and `hidayah-backend/` each are, separately. Run `git` inside one of those, never here.

### Where things stand (4 Nov 2026) — read this first
Two big features were built in the first days of Nov 2026, each by its own Claude session working in parallel (they coordinated by message and staged files by explicit path — never `git add -A` while another session has work in progress). Everything below is committed and pushed to `main` in both repos.

- **`hidayah-backend/.env` points at PRODUCTION** (`…yzyvei2…` cluster, db `test` — real client data). It was on a TEST cluster (`…tl4xg…`, db `hidayah`, demo accounts `*@hidaya.com` / `Demo@123`) for a few days and was switched back on 4 Nov; it may flip again. Print the host before any `--apply` script, and don't start the server locally against it (its background jobs write). Smoke tests are safe either way: each creates and drops its own throwaway database on whatever cluster the URI names.
- **WhatsApp** (details: *WhatsApp Cloud API* below, and `docs/WHATSAPP-PROGRESS.md`). Meta App Review approved 31 Oct 2026. Built and pushed:
  - Part 01: connect the number, two-way messaging, templates, phone sync.
  - Part 02: tutor class reminders.
  - Part 03: staff chat with hidden numbers and a fee filter, the admin inbox, per-person access levels.
  - Since then: the `/portal/whatsapp` page redesigned for non-technical users, plain-English Meta errors, send-to-student, and archive / remove-from-portal on WhatsApp Chats.

  **Production state, deliberately:**
  - WhatsApp is **locked to the super admin**: every `whatsapp.*` permission was pulled from all other roles on 4 Nov at the client's request. So do **not** run `migrate-add-whatsapp-chat-perms.mjs --apply` there — it would give the admin role the full inbox. Re-seeding the default roles would do the same, since `DEFAULT_ROLE_PERMISSIONS.admin` includes the inbox.
  - The number is **disconnected**. It had been onboarded under the developer's own "calcite" business. Re-onboarding under the client's business portfolio (3277320135614426) fails inside Meta's Embedded Signup with "isn't a valid Business ID (#1690130)". Already ruled out: admin rights, the app being Live, a fresh window. Unresolved; next steps would be removing the number from the old WABA, or a Meta support ticket.
  - The API Setup test number's 24-hour token (`WHATSAPP_ACCESS_TOKEN`) had expired.
  - Error 131042 = no payment method on Meta's business portfolio.
- **English Coach** (`/portal/english-coach`, details: *English Coach* below). Spoken role-play practice with an AI character, marked against IELTS/CEFR-style descriptors and Hidaya's own house rules. Built for the client (sold at PKR 8,000). It now has 14 scenarios built from the academy's training documents, 3 of them for managers only. **Production state:**
  - Coach permissions were applied on 4 Nov to admin, principal, coordinator, qci and qcm, but **not to tutors**. The client will switch tutors on later from the Roles page (`coach.practice` only — never `coach.manager`). `migrate-add-coach-perms.mjs --skip=tutor` exists for exactly this.
  - Still needed on Render: `GROQ_API_KEY` + `GEMINI_API_KEY`, optionally with `GROQ_API_KEYS` / `GEMINI_API_KEYS` backups. Without them the coach shows "not set up".
  - Optional: `node scripts/migrate-coach-add-3min.mjs --apply` to offer 3-minute calls.

### Repository layout
- `hidayah-frontend/` — React SPA (public site + admin + portal). Has its own `CLAUDE.md`.
- `hidayah-backend/` — Express/MongoDB REST API. Ad-hoc `.mjs` scripts live in its root and `scripts/`.
- `docs/` — non-code reference: `DEMO_CREDENTIALS.md` (all seeded demo accounts share password `Demo@123`; use these for smoke tests / manual QA against a demo-seeded DB) plus source spreadsheets (`Students Data.xlsx`, payment exports) consumed by the `import-*.mjs` scripts.
- `NOORANI-QAIDA-PLAN.md` + `Noorani Qaida.pdf` (root) — planning doc and source material for a **separate, not-yet-built** standalone "Digital Noorani Qaida" React app. Design spec only; no code exists in this tree yet.

**Sibling project, outside this tree:** `E:\CALCITE PROJECTS\quranTutor` — the qurantutornow.com Google Ads landing site (its own git repo, `asadawan16/QuranTutorFrontend`). It has no backend and calls this API for its trial form and its Pay now flow; see *Satellite marketing sites* below before touching CORS, `config/channelOffers.js`, or `/api/public/*`.

> `hidayah-frontend/` and `hidayah-backend/` are two **separate git repos** (`asadawan16/hidaya` and `asadawan16/hidaya-backend`), both on `main`. This root folder is not a repo — files here (including this `CLAUDE.md`) are untracked and local-only.

> When working on the frontend, also read `hidayah-frontend/CLAUDE.md` — it documents the required Portal UI kit (`src/portal/ui/`), the aurora/glass rendering-performance rules, and Tailwind v4 / rolldown-Vite conventions that are not repeated here.

## Commands

### Frontend (`hidayah-frontend/`)
```bash
npm run dev          # Vite dev server with HMR (localhost:5173)
npm run build        # Production build → dist/
npm run preview      # Serve production build locally
npm run lint         # ESLint
```

### Backend (`hidayah-backend/`)
```bash
npm run dev          # node --watch index.js (localhost:5000)
npm start            # Production start
npm run seed         # Create initial admin user from .env credentials
```

There is no test runner or lint script on the backend. Verification is done with the ad-hoc scripts below — run them with `node <script>` from the `hidayah-backend/` directory (they read `MONGODB_URI` / credentials from `.env`).

**Seed variants** (root of `hidayah-backend/`, run as `node seedX.js`):
- `seed.js` — initial super-admin only (also `npm run seed`)
- `seedPortal.js` — default roles + permissions catalog
- `seedStudents.js` — student records
- `seedDemo.js` — floods ALL models with realistic demo data (every portal feature populated)
- `seedClient.js` / `seedClientDemo.js` — focused client demo (10 students · 4 tutors · 3 families with history)

**`scripts/` folder** (run as `node scripts/X.mjs`):
- `reset-db.mjs` — drops ALL collections, reseeds default roles + one super-admin (+ legacy Admin) from `.env`. The standard "start clean" reset (dev DB is disposable).
- `precheck.mjs` / `verify-students.mjs` / `verify-permanent.mjs` — count documents / assert seed invariants
- `smoke-*.mjs` — end-to-end smoke tests per feature (chat, fees, sockets, schedule-board, notifications, notice-roles, payment-link-tax, stripe-payments, fee-gateway, public-checkout, student-progress, class-links, student-class-links, new-features). Note: `smoke-batch.mjs` and the socket/chat/notification smokes hit a **running server** over HTTP (`PORT`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`) — start `npm run dev` first; the others connect straight to Mongo.
- `import-*.mjs` — one-off data importers (students, daily/permanent lessons, tutor-changes). These read the spreadsheet path from `STUDENTS_XLSX`, not a hardcoded file.
- `reset-students.mjs` — wipes + reseeds only student records (narrower than `reset-db.mjs`); `pick-student.mjs` prints a student for ad-hoc inspection
- `migrate-*.mjs` — idempotent data migrations (e.g. `migrate-add-complaint-perms.mjs` backfills a new permission onto existing roles); run once after pulling a schema/permission change. `migrate-student-link-roll-tokens.mjs` is the one that CHANGES LIVE URLs — it re-addresses per-student class pages on the roll number, so links already shared have to be re-sent; dry-runs by default, `--apply` to write
- `students-lib.mjs` / `tutor-lib.mjs` — shared helpers (`loadAllModels`, etc.) used by the above

## Environment variables (`hidayah-backend/.env`)

There is no `.env.example`; the running `.env` is the source of truth. Keys consumed by the code:

- **Core:** `MONGODB_URI`, `PORT` (default 5000), `JWT_SECRET` (signs BOTH admin and portal tokens), `FRONTEND_URL` (CORS allow-list + links in emails/payment callbacks), `MFA_ENCRYPTION_KEY` (encrypts stored TOTP secrets)
- **Seed admin:** `ADMIN_EMAIL`, `ADMIN_PASSWORD` (used by `seed.js` / `reset-db.mjs`)
- **SMTP (mailer):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_EMAIL` (internal notification recipient)
- **Mastercard gateway:** `MC_API_USERNAME`, `MC_API_PASSWORD`, `MC_GATEWAY_URL`, `MC_MERCHANT_ID`
- **Stripe gateway:** `STRIPE_SECRET_KEY` (absence disables Stripe checkout entirely — the API returns 503), `STRIPE_WEBHOOK_SECRET` (`whsec_…` for the endpoint registered at `POST /api/stripe/webhook`; locally `stripe listen --forward-to localhost:5000/api/stripe/webhook` prints one)
- **AWS S3 (blog images / uploads):** `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `PRESIGN_EXPIRES`
- **WhatsApp Cloud API:** `WHATSAPP_APP_SECRET` (Meta App settings → Basic → App secret; signs every webhook POST), `WHATSAPP_VERIFY_TOKEN` (a string WE choose and type into Meta's webhook "Verify token" box)
- **English Coach AI:** `GROQ_API_KEY` / `GROQ_API_KEYS` (required — Whisper speech-to-text + the GPT-OSS character; without it the coach shows "not set up"), `GEMINI_API_KEY` / `GEMINI_API_KEYS` (recommended — the examiner + backup character; without it GPT-OSS also marks). Free keys: console.groq.com/keys, aistudio.google.com/apikey. Optional overrides: `COACH_STT_MODEL`, `COACH_GROQ_MODEL`, `COACH_GEMINI_ACTOR_MODEL`, `COACH_GEMINI_EXAMINER_MODEL`, `COACH_GROQ_BASE_URL`, `COACH_GEMINI_BASE_URL` (proxy / local stand-in)
- **Misc:** `CSP_ENABLED` (toggles Helmet CSP), `STUDENTS_XLSX` (import scripts), `PAY_SITE_URL` (optional — where `/pay/:token` lives when it differs from `FRONTEND_URL`; falls back to `FRONTEND_URL`, then the literal `https://hidaya.online`)

> CORS is **not** driven by env — it's the hardcoded allow-list in `config/sites.js`. See Satellite marketing sites.

Frontend uses only `VITE_API_URL` (defaults to `http://localhost:5000/api`).

## Tech Stack

**Frontend:** React 19, React Router v7 (BrowserRouter), Vite 8, Tailwind CSS v4 (via `@tailwindcss/vite` plugin — no tailwind.config.js), Framer Motion, GSAP + ScrollTrigger, Lucide React, Chart.js + react-chartjs-2, Socket.IO client. Marketing routes are prerendered to static HTML at build time (see SEO below). Three.js was removed — it only drew a login background.

**Backend:** Express 4 (ES modules), Mongoose 8 / MongoDB, JWT auth (jsonwebtoken + bcryptjs), Nodemailer 10 (SMTP; needs Node 20+), Mastercard Payment Gateway Integration, Socket.IO, Helmet + CORS + express-rate-limit, AWS S3 (blog images), otplib + qrcode (MFA/TOTP)

> **Dependencies (security pass, Nov 2026):** `xlsx` is installed from SheetJS's own CDN (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) because fixed versions are no longer published to npm; `package.json` has `overrides.qs` so Express's bundled `qs` is patched. `npm audit` leaves 3 moderate findings in archiver → readdir-glob → minimatch: npm's only fix is downgrading archiver 8 → 4, and the issue needs `glob()`, which the data export never calls — leave them. Don't run `npm audit fix --force`.

## Architecture

### Two-app structure
Frontend and backend are separate npm projects with independent `node_modules`. They communicate over REST — the frontend reads `VITE_API_URL` env var (defaults to `http://localhost:5000/api`). Backend allows the frontend origin via `FRONTEND_URL` env var in CORS config.

### Frontend routing (`src/App.jsx`)
All pages are lazy-loaded. Four layout contexts determined by `location.pathname`:

- **Public routes** — wrapped in `PublicLayout` (Navbar → main → Footer → WhatsAppFloat): `/`, `/about`, `/courses`, `/fee`, `/faqs`, `/contact`, `/free-class`, `/downloads`, `/refund-policy`, `/privacy-policy`, `/blog`, `/blog/:slug`, `/payment/callback`
- **Pay routes** — bare layout (no nav): `/pay/:token`, `/pay/:token/callback`
- **Admission** — standalone: `/admission` (public admission form, no portal auth)
- **Class links** — standalone, UNLISTED: `/class-links` (public meeting-link board shared with students; no nav entry anywhere, `noindex`, optional access code — managed at `/portal/class-links`)
- **Student class page** — standalone, UNLISTED: `/my-class/:token` (ONE student's private page: greets them by name, one Join button. The token is the credential, so the board's access code does not apply. `noindex`; managed at `/portal/class-links` → Student Links). **The token is the student's ROLL NUMBER** — `/my-class/hid518` — so a coordinator can read the URL down the phone; lookups are case-insensitive. A student with no roll number, and any link rotated via the modal's ↻ (the escape hatch for a URL that got forwarded), falls back to a random token. `scripts/migrate-student-link-roll-tokens.mjs` re-addresses existing links.
- **Admin routes** — wrapped in `ThemeProvider`, guarded by `RequireAuth`: `/admin/login`, `/admin/dashboard`, `/admin/payments`, `/admin/enrollments`, `/admin/payment-links`, `/admin/discount-codes`, `/admin/plans`, `/admin/students`, `/admin/blogs`, `/admin/subscribers`, `/admin/export`, `/admin/payment-settings`, `/admin/logs`
- **Portal routes** — wrapped in `ThemeProvider` + `PortalAuthProvider` + `SocketProvider` + `ToastProvider`, guarded by `RequirePortalAuth` with permission checks: `/portal/login`, `/portal/dashboard`, `/portal/users`, `/portal/roles`, `/portal/students`, `/portal/students/:id`, `/portal/tutors`, `/portal/admissions`, `/portal/curriculum`, `/portal/schedule`, `/portal/attendance`, `/portal/lessons`, `/portal/chat`, `/portal/assessments`, `/portal/assessments/:id` (an exam's report card — a page with charts, not a modal; students reach their own from My Progress), `/portal/notices`, `/portal/finance`, `/portal/reports`, `/portal/my-classes`, `/portal/my-progress`, `/portal/my-salary`, `/portal/profile`, `/portal/leads`, `/portal/whatsapp` (connect the number, reminders, Team access), `/portal/whatsapp-chats` (WhatsApp Chats — `anyPermission={['whatsapp.chat','whatsapp.chat_own']}`), `/portal/english-coach` (Practice / Team results / Settings), `/portal/english-coach/:id` (one call's scorecard)

### Two separate auth systems
1. **Admin auth** — `middleware/auth.js` verifies JWT, sets `req.adminId`. Token stored in `localStorage('admin_token')`. API client at `src/admin/api.js`.
2. **Portal auth** — `middleware/portalAuth.js` verifies JWT with `type: 'portal'`, loads User with populated roles, builds `req.userPermissions` (Set). Token stored in `localStorage('portal_token')`. API client at `src/portal/api.js`. Supports MFA (TOTP via otplib).

### RBAC (Portal)
- **Student accounts are scoped by `middleware/studentScope.js`, not just by permissions.** Many routes are guarded only by `portalAuth` (check-in, leave, chat) or by a read permission the student role also holds. `denyStudentAccounts` (route guard) and `rejectForeignStudent` / `isStudentAccount` (in controllers) are how a route says "not for students" or "only their own record". A student account = linked to a Student and holding no role but `student`. Any new route reachable by students must use one of these.
- **Family tutor-change requests name no tutor.** `TutorChangeRequest.toTutorId` is optional; a student's request carries `concerns[]` + `reason` + `source: 'student'`, notifies admin/QCM/QCI, and the reviewer picks the tutor at approval (`POST /:id/approve` with `toTutorId`). Tutors hold no `assignment.read`, so they never see the queue.
- **Staff are payroll/HR subjects alongside tutors.** `LeaveRequest`, `Advance`, `TutorAttendance` and `SalaryRecord` all carry `subjectType` + either `tutorId` (TutorProfile) or `userId` (User) — never both. Rows written before a model gained the field have no `subjectType`, so filter tutors with `{ $ne: 'staff' }`, not `=== 'tutor'`. Staff have an **Employee ID** (`User.employeeId`, `E01…`, the counterpart of `TutorProfile.tutorId`): `utils/employeeId.js#ensureEmployeeIds` numbers anyone missing one when the staff list or salary roster is read (there is no single "create staff" path to hook), and the field must stay ABSENT when unset — its unique index is partial. Leave: anyone files their own; only `leave.review`/`tutor.update` holders see or file for others, and nobody but the super admin reviews their own. `GET /portal/finance/salary/roster` returns an org-wide `summary` (per currency, Total = Paid + Remaining) regardless of `scope`. Verify with `node scripts/smoke-staff-hr.mjs` (throwaway DB, no server needed).
- Permissions defined in `config/permissions.js` as flat `domain.action` strings (e.g. `student.read`, `lesson.log`)
- **Per-person grants:** `User.extraPermissions` adds permissions on top of a user's roles, but only those in `USER_GRANTABLE_PERMISSIONS` (`whatsapp.reminder`, `whatsapp.chat_own`, `whatsapp.chat`, `whatsapp.inbox` — all set per person on `/portal/whatsapp`) — enforced by the model validator AND again in `portalAuth#effectivePermissions`, so a hand-written DB value can't grant anything else. `/me` and login return `extraPermissions`; the frontend's `hasPermission` merges them. Changing someone's grant emits `permissions_changed` to them and their open tabs re-read `/me`.
- `requirePermission(...perms)` middleware factory checks all specified permissions are present
- Default roles: `super_admin`, `admin`, `principal`, `coordinator`, `qci`, `qcm`, `tutor`, `student`
- Frontend `RequirePortalAuth` accepts `permission` (all required) or `anyPermission` (an array, one is enough) to gate routes; `PortalLayout` nav items take `permission`, and DIRECT_NAV items also `anyPermission`

### Backend API routes
All prefixed with `/api`:

**Original admin routes** (auth via `middleware/auth.js`):
- `/auth` — admin login/me
- `/payments` — payment CRUD + fee-page checkout (`initiate` / `initiate-paypal` / `initiate-stripe` / `callback`, all public) + the `feeGateway` switch (`GET /settings` public · `GET /settings/admin` + `PATCH /settings` admin)
- `/enrollments` — enrollment form + admin management
- `/payment-links` — create/send payment links, public pay flow via `/t/:token`
- `/discount-codes` — CRUD + public validate
- `/plans` — pricing plans
- `/students` — student CRUD + bulk ops
- `/blogs` — blog CRUD with S3 images
- `/subscribers` — newsletter management
- `/uploads` — S3 presigned URLs
- `/export` — full DB export (ZIP)
- `/logs` — system logs
- `/class-links` — PUBLIC (no auth): `GET /public` (active links, optional `?code=`) + `POST /:id/click`, plus the per-student pages: `GET /student/:token` + `POST /student/:token/click`
- `/stripe/webhook` — PUBLIC, **raw body**, signature-authenticated (see Payment gateways). Mounted directly in `index.js`, not via a router, because it must precede `express.json()`.
- `/whatsapp/webhook` — PUBLIC, **raw body**, signature-authenticated (`X-Hub-Signature-256` HMAC with `WHATSAPP_APP_SECRET`). `GET` = Meta's verify handshake (echoes `hub.challenge` when `hub.verify_token` matches), `POST` = incoming messages + status updates on messages we sent. Mounted in `index.js` before `express.json()` like Stripe. See WhatsApp below.
- `/public` — PUBLIC (no auth), for satellite marketing sites: `GET /offers/:channel` (price book), `POST /checkout` (mint a Stripe link, get back a hidaya.online pay URL), `POST /trial` (free-trial enquiry → Leads board). See Satellite sites below.

**Portal routes** (auth via `middleware/portalAuth.js` + permission checks). Mount path ≠ route filename in several cases — the mounts below are authoritative (`index.js` lines ~135-166):
- `/portal/auth` — login (with MFA), me, MFA enroll/confirm/revoke; also `forgot-password`/`reset-password`
- `/portal/users` — user CRUD, password reset
- `/portal/roles` — role CRUD, permissions catalog
- `/portal/students` — student management (separate from admin students)
- `/portal/tutors` — tutor profiles
- `/portal/admissions` — admission applications
- `/portal/curriculum` — curriculum items
- `/portal/assignments` — tutor-student assignments
- `/portal/tutor-change-requests` — tutor reassignment requests (`portalTutorChangeRoutes`)
- `/portal/schedule` — class scheduling (slots, sessions)
- `/portal/attendance` — tutor attendance
- `/portal/lessons` — lesson entries (daily + permanent)
- `/portal/chat` — messaging threads
- `/portal/assessments` — assessments + templates
- `/portal/notices` — notices + complaints
- `/portal/finance` — invoices + salary records. `GET /salary/mine` is the self-service exception: no `salary.read`, scoped to the caller's own tutor profile (`linkedTutorId`, falling back to `TutorProfile.userId`) and/or staff `userId`, student accounts refused. It feeds `/portal/my-salary` (top-level nav item for every employee except the super admin; employees download their slip there). Verify with `node scripts/smoke-my-salary.mjs` (throwaway DB, no server needed)
- `/portal/families` — family records (`portalFamilyRoutes`)
- `/portal/leads` — lead management. Call follow-ups: a `callback` status, `Enrollment.nextCallbackAt` and a `callLog[]`; `POST /:id/log` adds an entry (a callback date moves the lead to Callback; enrolled/closed drop the callback). List filters `callbackFrom`/`callbackTo`/`scheduled` sort soonest first and return only `lastNote`. Ported from the `client/myfuturecampus` branch WITHOUT its academic demo-request fields (program/grade/subject…). Verify with `node scripts/smoke-lead-callbacks.mjs` (throwaway DB)
- `/portal/demos` — demo/trial classes (`portalDemoRoutes`)
- `/portal/certificates` — student certificates
- `/portal/badges` — student badges
- `/portal/student-progress` — progress tracking (`portalStudentProgressRoutes`)
- `/portal/billing` — student billing/payments (`portalPaymentRoutes`)
- `/portal/fees` — fee records (`portalFeeRoutes`)
- `/portal/expenses` — expense tracking
- `/portal/advances` — staff salary advances
- `/portal/leaves` — staff leave requests
- `/portal/awards` — employee-of-the-month (`portalEmployeeAwardRoutes`)
- `/portal/shift-config` — overnight shift window config (see `utils/shiftWindow.js`)
- `/portal/reports` — reports
- `/portal/dashboard` — dashboard stats
- `/portal/notifications` — in-app notifications
- `/portal/class-reminders` — a tutor's WhatsApp class reminders (`whatsapp.reminder`, per person): `GET ?sessionIds=` (state of their own classes) + `POST /:sessionId` (send). The admin side is under `/portal/whatsapp/reminders` (`settings`, `template`, `access`, and the log). See WhatsApp → Class reminders
- `/portal/whatsapp-chats` — WhatsApp Chats, the team's WhatsApp inbox (any chat level: `whatsapp.chat_own` / `whatsapp.chat`; the full view needs `whatsapp.chat` + `whatsapp.inbox`). Levels are set per person at `/portal/whatsapp` → Team access (`GET/PUT /portal/whatsapp/access`). See WhatsApp → Staff chat & admin inbox
- `/portal/class-links` — the public class-links board + its page settings, and `/students` + `/students/bulk` + `/students/bulk-delete` for the per-student links (`class_link.read`/`class_link.manage`, super-admin only by default)
- `/portal/data-export` — the disaster-recovery backup (`data.export`, super-admin only by default): `GET /download` streams every portal collection as CSV in one ZIP, `GET /status` feeds the Data Export page, `GET /reminder` drives the weekly popup (`DataExportReminder` in GlobalOverlays). **What goes in is `config/dataExport.js`** — a new model must be added to `EXPORT_COLLECTIONS` or `EXCLUDED`, and `scripts/smoke-data-export.mjs` fails until it is. Legacy admin-portal data (Admin, BlogPost, Subscriber) is deliberately excluded, and credentials (`User.password`, `mfa.secretEnc`, `passwordReset`, `pushTokens`) are never written. Each collection is read from Mongo ONCE (rows staged as JSON lines in `os.tmpdir()` while the header is collected) and collections are appended to the ZIP one at a time — archiver starts reading a stream the moment it is appended. Each completed download writes a `DataExport` row. The legacy `/api/export` admin export is separate and untouched
- `/portal/coach` — the English Coach (see English Coach below): `config`, `sessions` (start, `/:id/turns` raw audio, `/:id/finish`, `/:id/rescore`, `/mine`), reviewer `sessions` list + `people` + `overview` + `PATCH /:id/review`, manager `DELETE /:id` + `settings`

### Real-time
- **Socket.IO** (`config/socket.js`) — `/portal` namespace for portal real-time features (chat, notifications). Authenticated via JWT handshake.
- **WebSocket** (legacy) — `/ws/export` path for admin DB export progress. Authenticated via `?token=` query param.

### Backend services
- `services/mastercard.js` — Mastercard Payment Gateway checkout session creation and order retrieval (Basic auth, REST API v73)
- `services/stripe.js` — Stripe hosted Checkout (one-off + subscription), coupons, subscription cancel, webhook signature verification
- `services/paymentLinkFulfillment.js` — gateway-agnostic payment-link settlement shared by every callback/webhook path
- `services/mailer.js` — Nodemailer SMTP transport with HTML email templates for enrollment notifications, payment confirmations, and invoices. Invoice email shows discount breakdown (original → discount code → total paid) when a discount was applied.

### Backend controllers
Route handlers are in `controllers/` — original routes use inline handlers in route files, portal routes use dedicated controller files (`portalAuthController.js`, `portalStudentController.js`, etc.).

### Backend utils (`utils/`)
- `shiftWindow.js` — overnight shift-window math. The academy runs an 8 PM→7 AM PKT shift labelled by its start day; classes after midnight are dated to the next calendar day (`SHIFT_WRAP_HOUR=7`). Any date-bucketing of sessions/attendance goes through here — don't reimplement day boundaries inline.
- `dstShift.js` — the Schedule page's **Daylight saving** switch (`PUT /portal/schedule/dst`, super_admin/admin only). PKT has no DST, but students' countries do, so ON moves every `ClassSlot` and every not-yet-started `ClassSession` from the shift in progress onward 60 min later on the PKT clock; OFF moves them back. Stored times really change — every reader (portal, mobile, class pages) just sees them. Started/completed/missed sessions are history and keep their time. Each row carries `dstShifted`, so a re-send is a no-op and a half-failed toggle is finished by sending it again; slots/sessions created while it's on are marked so OFF moves them too. Midnight keeps the shift-day, crossing the 7 AM wrap changes `dayOfWeek`. `SHIFT_WRAP_HOUR` now lives in `shiftWindow.js` (re-exported by the schedule controller). The Schedule page's modal shows `GET /portal/schedule/dst/preview` (a dry run: slots, sessions, midnight / 7 AM crossings, live classes) and needs the admin to type TURN ON / TURN OFF; the server refuses (409) while any class of the current shift is `started`. **Before flipping it on live data, run `node scripts/schedule-times-snapshot.mjs`** (read-only; writes `backups/`, gitignored) — `--restore <file>` dry-runs, `--restore <file> --apply` puts every time back. Verify with `node scripts/smoke-dst-toggle.mjs` (throwaway DB).
- `activityLogger.js` — writes `Log` documents for audit trails
- `cleanupPayments.js` — the pending-payment expiry background job (see Background jobs)
- `totp.js` — TOTP secret encryption/verification for portal MFA (uses `MFA_ENCRYPTION_KEY`)

### Backend models
Core: `Admin`, `User` (portal), `Role`, `Student`, `StudentStatusHistory`, `TutorProfile`, `StaffProfile`, `Family`, `StudentRelationship`
Academic: `ClassSlot`, `ClassSession`, `PermanentLesson`, `LessonEntry`, `CurriculumItem`, `Assignment`, `TutorChangeRequest`, `Assessment`, `AssessmentTemplate`, `TutorAttendance`, `ScheduleConfig`, `ShiftConfig`
Business: `Payment`, `PaymentLink`, `Plan`, `DiscountCode`, `Invoice`, `FeePayment`, `StudentFeeRecord`, `SalaryRecord`, `SalaryIncrement`, `Advance`, `Expense`, `Enrollment`, `AdmissionApplication`, `DemoTrial`
HR/recognition: `LeaveRequest`, `EmployeeOfMonth`, `Badge`, `Certificate`
Communication: `ChatThread`, `Message`, `Notice`, `Complaint`, `Notification`, `WhatsappReminderLog` (legacy), `ClassReminder`, `WhatsappReminderSettings`, `WhatsappMessage`, `WhatsappChat` (derived chat list), `WhatsappConnection`, `ClassLink`, `ClassLinkSettings`, `StudentClassLink`
Content: `BlogPost`, `Subscriber`, `Log`
Training: `CoachSession` (one English Coach practice call + its scorecard), `CoachSettings` (singleton)
Infrastructure: `DataExport` (one row per completed portal backup), `StripeEvent` (webhook idempotency ledger, 30-day TTL), `PaymentSettings` (singleton — which gateway the fee page uses)

### Payment gateways (Mastercard + Stripe)
A payment link picks its processor at creation time (`PaymentLink.gateway`: `mastercard` | `stripe`) and its billing mode (`PaymentLink.paymentMode`: `one_time` | `recurring`).

- **Recurring is Stripe-only** — the Mastercard hosted checkout here does a single PURCHASE and stores no mandate. `utils/paymentLinkOptions.js#normalizeGatewayFields` enforces this for BOTH create paths (admin `paymentLinkController.create` and portal `portalPaymentController.createPaymentLink`) and forces `expiresAfterPayment: false` on recurring links so every cycle can charge against the same link.
- **Public initiate endpoints** (all under `/api/payment-links/t/:token`): `pay` → Mastercard, `pay-paypal` → Mastercard/PayPal, `pay-stripe` → Stripe hosted Checkout (`mode: 'payment'` for one-off, `mode: 'subscription'` for recurring). The Stripe route returns `{ url }`; the browser is redirected there.
- **`services/stripe.js`** — hosted Checkout only, no card data ever touches this server. `toMinorUnits()` handles zero/three-decimal currencies (never multiply JPY by 100).
- **Webhook `POST /api/stripe/webhook`** is the authority on payment truth and the ONLY signal for renewal charges. It is mounted in `index.js` with `express.raw()` **before** `app.use(express.json())` — the signature is computed over the exact bytes Stripe sent, so a re-parsed body never verifies. Idempotency: each `event.id` is claimed in the `StripeEvent` collection (unique index, 30-day TTL) before any work, so a redelivery is a no-op. Handles `checkout.session.completed`, `invoice.paid` (← the recurring money), `invoice.payment_failed`, `customer.subscription.updated/deleted`, `charge.refunded`.
- **`services/paymentLinkFulfillment.js`** holds everything shared by the three settle paths (Mastercard return, Stripe return, Stripe webhook): `generateInvoiceNo`, `priceLinkCharge`, `buildPaymentData`, `settleLinkPayment`. `settleLinkPayment` is idempotent — pass `alreadySettled: true` on a re-entry and it skips the one-shot side effects (discount counter, emails, invoice-number rotation). Don't reimplement any of this inline in a controller.
- **One Payment document per charge.** A subscription's first cycle reuses the pending placeholder created at checkout; every renewal mints a new Payment with a fresh invoice number. `Payment.stripeInvoiceId` carries a unique partial index so a redelivered `invoice.paid` can never double-record a cycle (the field must stay ABSENT on non-Stripe payments — don't give it a `''` default).
- **Discount codes on recurring links** apply to the FIRST invoice only, via a `duration: 'once'` Stripe coupon. The recurring price itself is always amount + tax.
- Portal management: `GET /portal/billing/payment-links/:id/subscription` and `POST .../cancel-subscription` (cancel-at-period-end by default; gated on `payment_link.delete`).
- Verify with `node scripts/smoke-stripe-payments.mjs` — runs against Mongo only, no Stripe key or running server needed.

**The public fee page (`/fee`) is a separate flow from payment links** and picks its processor from one admin-controlled switch, not per purchase:

- `PaymentSettings` is a singleton (`key: 'default'`) holding `feeGateway` (`mastercard` | `stripe`). Edited at **Admin → Payment Settings** (`/admin/payment-settings`), read by the fee page from the public `GET /api/payments/settings`. Payment links are unaffected — each carries its own `gateway`.
- **`resolveFeeGateway()` degrades, the stored value doesn't.** A `stripe` setting on a host with no `STRIPE_SECRET_KEY` is served to the fee page as `mastercard`, because the alternative is a Pay button whose only possible answer is 503. The admin page reads `GET /api/payments/settings/admin`, which reports what is actually stored plus `stripeConfigured`, and refuses to save `stripe` without a key.
- Three initiate paths — `POST /api/payments/initiate` (Mastercard), `initiate-paypal`, `initiate-stripe` — all validate and price through one `pricePlanCharge()` helper in `paymentController.js`, so the amount, discount rules and multi-student quantity can't drift between gateways. All three share the `rl(50)` cap; each is listed explicitly in `index.js` because `app.use('/…/initiate')` does NOT match the hyphenated siblings.
- **`finalizePlanPayment()` is the fee-page equivalent of `settleLinkPayment`** — same idempotency contract (`alreadySettled: true` skips the discount counter and the emails), shared by the Mastercard return, the Stripe return and the webhook. `settlePlanPaymentFromSession()` wraps it for a Stripe session.
- A fee-page Stripe session has **no `paymentLinkId` in its metadata** (it carries `kind: 'plan'` instead). `stripeWebhookController.onCheckoutCompleted` treats a session with no link behind it as a plan purchase rather than dropping it — that branch is the only thing that records the money if the payer closes the tab on Stripe's page.
- `/payment/callback` posts `{ sessionId }` for Stripe and `{ orderId }` for Mastercard/PayPal to the same `POST /api/payments/callback`.
- Verify with `node scripts/smoke-fee-gateway.mjs` — Mongo only; the Stripe-disabled assertions self-skip when a real key is in `.env`.

### WhatsApp Cloud API (Meta)
Meta app "HidayaOnlineApp" (WhatsApp use case). Callback URL registered with Meta: `https://hidaya-backend-4dsl.onrender.com/api/whatsapp/webhook`, subscribed to the `messages` field.

- `controllers/whatsappWebhookController.js` acks with 200 first, then processes (Meta retries anything slow). Every message lands in `WhatsappMessage` — `direction: in|out`, unique `wamid`, so a redelivered webhook is a no-op.
- Inbound messages are matched to a `Student` by phone (`findStudentIdByPhone`: last 10 digits, any formatting, across `whatsappNumber` / `phone` / `guardians.phone`); unknown numbers keep `studentId: null`. Socket events `whatsapp_message` / `whatsapp_status` go to `super_admin` + `admin` rooms (the WhatsApp page); WhatsApp Chats uses its own content-free event, below.
- Statuses only move forward (`sent → delivered → read`, or `failed` with Meta's error code). A status for a wamid we never stored is ignored — outbound sends must create the `out` row with Meta's returned wamid for statuses to attach.
- Media is not downloaded at ingest; only the Meta media id is kept.
- While the Meta app is **Unpublished**, webhooks still arrived for the API Setup test number (replies from an allowed recipient's phone, Oct 2026) — but publish the app before relying on real parents' messages to the academy's own number.
- **The number is connected at `/portal/whatsapp`** (`whatsapp.manage`, super-admin only by default) via Meta **Embedded Signup** with `featureType: 'whatsapp_business_app_onboarding'` — *coexistence*: the number stays live in the WhatsApp Business app on the office phone. The page runs `FB.login`, takes the `code` + the WABA/phone ids from the `WA_EMBEDDED_SIGNUP` postMessage, and `POST /api/portal/whatsapp/connect` exchanges the code (`services/whatsappGraph.js`), checks the number is on that WABA, calls `POST /{waba}/subscribed_apps`, then requests the contacts + history replay (`/{phone}/smb_app_data` — Meta accepts it only within 24h of onboarding). Result lives in the `WhatsappConnection` singleton; the business token is AES-GCM encrypted with `MFA_ENCRYPTION_KEY` and the model is excluded from the data export. App id / ES config id are public and default in code (`META_APP_ID`, `WHATSAPP_ES_CONFIG_ID`, `META_GRAPH_VERSION` override). The JS SDK only returns to domains on the Meta app's allow list (hidaya.online).
- Coexistence webhooks: `smb_message_echoes` (typed on the phone → `out`, `source: 'app'`) and `history` (past chats → `source: 'history'`, no socket events; progress + "declined" land on `WhatsappConnection`). These fields must be ticked in the Meta app's Webhooks config alongside `messages`. `WhatsappMessage.source` = `live` | `app` | `history`.
- Verify with `node scripts/smoke-whatsapp-webhook.mjs` — runs against a throwaway `hidaya_whatsapp_smoke` database and drops it; no Meta account or running server needed. `node scripts/smoke-whatsapp-connect.mjs` covers the connect flow with Meta stubbed out (throwaway DB too).
- **Plain-English errors** (`utils/whatsappErrors.js`): `plainWhatsappError(code, fallback)` turns Meta's codes (131042 billing, 131047 24h window, 131026 not on WhatsApp, 132001 template missing, 190 expired token…) into a sentence staff can act on; `plainFailure(message)` does the same for a stored failed message. Every screen-bound error goes through it: the WhatsApp page's send/templates (`senderError` — an expired token on the API Setup TEST number says "ask your developer", on a connected number "reconnect"), WhatsApp Chats sends, the reminder log and the tutor's reminder state (`failedReason`). `GET /portal/whatsapp/messages` adds `failedReason` per failed row and `stats.failed`. **`POST /portal/whatsapp/messages` takes `studentId` instead of `to`** — the number is resolved like a class reminder (`resolveStudentRecipient`), the row is linked to the student, and the response carries `recipient` ({ label, studentName }). Verify with `node scripts/smoke-whatsapp-send.mjs` (24 checks, throwaway DB, Meta stubbed).
- **Staff chat & admin inbox** (`/portal/whatsapp-chats`, `controllers/portalWhatsappChatController.js`). **Access is a per-person level** (`utils/whatsappAccess.js`, all four perms are `USER_GRANTABLE_PERMISSIONS`, set on Team access — `controllers/portalWhatsappAccessController.js`): Off · Own students (`whatsapp.chat_own`, a tutor's currently-assigned students only — other chats/files 404) · All chats (`whatsapp.chat`) · Full inbox (+ `whatsapp.inbox`). No staff role holds a level by default; admin/super admin keep the full inbox; a role-granted level is a floor (higher of role and personal wins). The socket room is joined from role + personal perms and moved live by `setUserRoom` when a level changes. One page, two server-decided views: own/all = STAFF view — the contact's number is never sent (chats addressed by `WhatsappChat._id`, digit searches don't match numbers, a numeric profile name is dropped), messages that `utils/feeFilter.js#isFeeMessage` flags (English / Roman Urdu / Urdu keywords, template names, file names — checked at READ time) arrive as `{ hidden: 'fees' }` with no text or media, staff can't send fee talk (422) or templates/files. **Phone numbers written inside messages are hidden too** (Nov 6 2026, client request): `utils/phoneMask.js#maskPhoneNumbers` turns any 7–15-digit number (with +/00, spaces, dashes, dots, brackets; Western, Arabic-Indic or Urdu digits; dash/dot dates left alone) in a message's text, caption or file name into `[number hidden]` in `describeMessage` — so the thread and the list preview — and a staff reply containing one is refused (422 `phone_number`). The admin inbox sees everything as sent. A number inside a photo can't be hidden. `whatsapp.chat` + `whatsapp.inbox` = FULL view (admin): numbers, everything, templates, photo/document upload (raw body → Meta `/media`), media relayed via `GET /media/:messageId`. Unread is shared by the team (`readByStaffAt`); staff never mark a fee message read, so it stays unread for the admin; history replays never count. Free text needs the 24 h window (`lastInboundAt`; Meta's 131047 maps to the same message). `WhatsappChat` is DERIVED — every message write calls `utils/whatsappChats.js#touchChat`, `ensureChats()` backfills missing rows once per process, and it's excluded from the data export. Live updates are a content-free `whatsapp_chat_activity { chatId }` to the `whatsapp-chats` socket room; the page refetches through the API. New perms need `node scripts/migrate-add-whatsapp-chat-perms.mjs --apply` on an existing DB (admins only), then levels on Team access. Verify with `node scripts/smoke-whatsapp-chats.mjs` (107 checks, throwaway DB, Meta stubbed).
- **Archive / remove from portal** (full inbox only — `POST /portal/whatsapp-chats/:id/archive {archived}` and `DELETE /portal/whatsapp-chats/:id`, both team-wide). Archived = `WhatsappChat.archivedAt`: out of every list but the `archived` filter (`archivedCount` comes with the first page), and `syncChat` un-archives it when a new non-history inbound message arrives. Removed = `WhatsappChat.clearedAt`: nothing is deleted (DB, phone, WhatsApp keep everything) — `visibleSince(chat)` hides messages up to the cut-off in the thread, the media relay, read-marking and the WhatsApp page's latest conversations; its unread are marked read; the row is KEPT with `lastMessageAt: null` (the list requires non-null) so the cut-off survives rebuilds, and the chat returns with only newer messages. Verify with `node scripts/smoke-whatsapp-chats.mjs` (107 checks).
- **Class reminders** (`controllers/portalClassReminderController.js`). A tutor taps **Send reminder** on one of their own classes (Schedule → Sessions, the dashboard's Today's schedule, the class-time popup) and the approved template goes from the academy's number to the student's WhatsApp recipient. Rules, all server-side: caller must hold `whatsapp.reminder` (granted **per tutor** on `/portal/whatsapp` → Who can send reminders — no default role has it, so the tutor role alone shows nothing); only the session's own tutor (`linkedTutorId`, fallback `TutorProfile.userId`); the window opens at the class start (PKT, 60 s clock tolerance) and closes at its scheduled end or when it is completed/missed; students on `leave`/`left` are never reminded; **once per class** — `ClassReminder.sessionId` AND `dedupeKey` (student + PKT day + start) are both unique, so a second tap, a regenerated session or two tabs at once can't double-send. Claim → Meta → record: a Meta refusal deletes the claim (tutor can retry once fixed), a Graph timeout keeps it until it is 2 min stale (outcome unknown), and a later webhook `failed` (e.g. 131042 — no payment method on the business portfolio) lets the tutor **Try again** while the class is on (the resend replaces the failed row). Recipient order (`utils/waNumber.js#resolveStudentRecipient`): guardian with `isWhatsappRecipient` → `whatsappNumber` → other guardians → legacy `phone`; local `03xx…` numbers are converted to +92 only for Pakistani students. **The tutor never receives the number** — only `Mother`/`Student` etc. Template + variable mapping + master on/off live in the `WhatsappReminderSettings` singleton (template must be APPROVED to switch on; media headers / variable buttons refused); `class_time`/`class_date` are rendered in the student's own timezone. Each send also writes a `WhatsappMessage` (`sentBy` = tutor, `studentId` set) so it shows on the WhatsApp page, and the webhook pushes `class_reminder_status` to the sending tutor. The old Notices → WhatsApp tab (`whatsapp.send`, a `wa.me` link that exposed the number) is retired; `POST /portal/notices/whatsapp-reminder` returns 410. Verify with `node scripts/smoke-class-reminders.mjs` (56 checks, throwaway DB, Meta stubbed, no server).

### English Coach (`/portal/english-coach`)
Spoken role-play practice for tutors and staff: an AI character (14 scenarios — trial classes, classroom situations, parents, small talk, and three for managers only) or, in the 11 scripted parts, the Role-Play Practice Book word for word, talks with the tester (Very easy/Easy/Normal/Challenging; 3/5/10 min), then the call is marked. Built for the client in Nov 2026 on **free** AI models only.

- **Four models, two providers** (`services/coachAi.js`, plain HTTPS in the OpenAI dialect): Whisper large-v3-turbo on Groq listens (word timings), GPT-OSS 120B on Groq plays the character (→ Gemini Flash-Lite), Gemini 3.6 Flash examines (→ GPT-OSS). Each step has a **ranked list of models** (Groq retired Llama 3.3 and Google closed Gemini 2.5 to new keys in Nov 2026): a model the provider reports as gone is skipped for 6 h, a 429/overload rests that model only, and each step has a time budget. **Several keys per provider**: `GROQ_API_KEYS` / `GEMINI_API_KEYS` (comma-separated, alongside the single-key vars) — first key until it runs out or is rejected, then the next; limits tracked per key + model, Kokoro-82M speaks **in the browser** (`kokoro-js` in a Web Worker, ~90 MB cached once; falls back to the browser's built-in voice, then captions only). A 429 rests that model+key (Retry-After, 30 min for a daily cap) and the next one in the list is tried straight away.
- **Fluency is measured, never guessed** (`utils/coachMetrics.js`, pure functions): words/min, long pauses, "um/uh" per minute, response time (browser-measured delay + leading silence), MATTR word variety. Whisper is prompted to keep fillers; its "Thank you." hallucination on silence is treated as no speech. Marking is IELTS/CEFR-anchored (strict below the comfortable range, flat inside it, so good calls are not marked down): **fluency = ½ measured** (wpm, hesitations, long pauses, response time, words per answer) **+ ½ the examiner's fluency-and-coherence mark**; vocabulary = examiner, word variety nudges it by +5 at most; the examiner also returns an estimated CEFR level and applies explicit penalties (vague/evasive, no plan, wrong info/over-promising/fees, blaming, one-line answers, unclear). Overall = weighted six areas (fluency 20 · grammar 20 · vocabulary 15 · professionalism 15 · clarity 15 · handling 15), then gated: ≤ handling + 15, ≤ weakest area + 30, ≤ 60 under 80 words. Bands 85 / 70 / 50. Live calibration (Nov 2026): weak call ~40 (A2), typical ~62 (B1), strong ~95 (C2).
- **The examiner is never trusted as-is** (`services/coachExaminer.js`): JSON parsed defensively, scores clamped (0–10 answers rescaled), a missing area rejects the answer (other provider retried), every correction must quote what the tester actually said (invented quotes dropped), transcript fenced as data against prompt injection.
- **Call lifecycle** (`controllers/portalCoachController.js`): one `active` call per user (partial unique index); each answer is a raw-audio POST with a `clientTurnId` (a retried upload replays the stored reply); a per-call `busyAt` lock serialises answers; answers are accepted for 60 s after the buzzer; `finish` → `scoring` (or `too_short` under `minTesterWords`, `abandoned` with no answers) and the examiner runs in the background. Quota exhaustion while marking **waits and retries** rather than failing; 3 unusable examiner answers → `failed` (retry from the scorecard). `sweepCoachSessions` (startup + every 2 min) closes calls whose tab was closed and resumes marking a restart interrupted. **Audio is never stored** — transcript, measurements and scores are.
- **Permissions:** `coach.practice` (tutor, coordinator, qci, qcm, principal), `coach.review` (principal, qci, qcm — everyone's results, the Team tab, and a human mark + note on a test; nobody reviews their own; the AI-vs-reviewer difference is the calibration figure), `coach.manage` (settings: on/off, call lengths, per-person and academy-wide 24-hour caps that protect the free quota, minimum words, scenarios). Student accounts are refused. Existing roles need `node scripts/migrate-add-coach-perms.mjs --apply` (add-only).
- **Hidaya's own training is built in** (Nov 2026, from the client's documents: *Trial Class Training* for teachers and managers, *Hidaya Tutor Training Official Oct 2026*, the *Role-Play Practice Book*, the *Training Booklet*). 14 scenarios in `config/coachScenarios.js`, each with a `group` (`SCENARIO_GROUPS`: trial · class · parents · conversation · manager) and an `audience` (`tutor` default | `manager`). New tutor ones: `trial_parent_feedback`, `trial_child`, `class_focus`, `recitation_correction`, `parent_boundaries`, `class_technical`; manager-only: `manager_enrolment`, `manager_tutor_feedback`, `manager_complaint`. **Manager scenarios need `coach.manager`** (principal, coordinator, qci, qcm, admin by default; never tutor): `getConfig` leaves them out and `startSession` refuses them otherwise (`canUseScenario`). The character's notes list *things to bring up*, which the persona prompt works through one per reply; a scenario's `testerRole` tells the character who it is talking to. `academyLines` are the academy's model sentences: snapshotted on the session, hidden until the call ends, shown on the scorecard ("How Hidaya's training says it") and given to the examiner as the wording to prefer in corrections. The examiner also marks against `HOUSE_RULES[audience]` (tutor: courtesy words, never "wrong", no time promises, no blaming, fees/schedule/teacher changes/complaints to the supervisor, no personal contact or private classes, don't guess religious answers; manager: honest about prices/policies, never criticise a tutor to a parent, evidence-based staff feedback) and corrects `COMMON_ERRORS` (Urdu-speaker patterns from the manuals). Calls taken before this have no audience and are marked as tutor calls. Whisper's prompt now carries Islamic/Quran terms (Qaida, Ghunnah, InshaAllah…) so they transcribe correctly. Existing roles need `node scripts/migrate-add-coach-perms.mjs --apply` (it now includes `coach.manager`). Live-checked Nov 2026: a policy-perfect parent-boundaries call scored 90 (C1), a tutor who quoted a fee and gave out his number scored 45.
- **The Role-Play Practice Book, word for word** (Nov 6 2026, client request: tutors are beginners, so "no out-of-the-box responses" for them). `config/coachRolePlays.js` holds all 48 role plays of the *Quran Tutor English Role-Play Practice Book* (Teacher + Student PDFs), in 11 units, written out in conversation order — in some plays the student or parent speaks first, and the PDF's table rows do not show that, so the order was set by hand from the page images. Each unit is a **scripted scenario** (`kind: 'script'`, keys `book_unit_01`…`book_unit_11`, group `roleplay`, listed first). **No AI plays the character**: the tester says the teacher (`T`) line, `utils/coachScript.js#scriptMatch` compares it with the book's line (word-level LCS F-score after normalising contractions, Arabic spellings like Assalamu Alaikum/InshaAllah, digits, fillers; word order counts), and a pass — or a second miss — plays the book's next `S`/`P` line(s), each in its speaker's voice (`BOOK_SPEAKERS`: Ahmad, Sara, Ahmad's mother); a first miss returns no reply and the screen shows the book's line to say again. Pass mark rises with difficulty (`SCRIPT_PASS`). The session snapshots the book (`CoachSession.script`, `scriptPos`, `scriptTries`; each tester turn carries `check`), the tester picks a role play to start from (`startPlay`), and reaching the last line closes the call itself (`endReason: 'completed'`). Marking: **handling = `scriptScore`** (right first time scores its match, second try −15, missed = half), the examiner gets a line-by-line table and marks the rest; `result.script` + `session.script.lines` feed the scorecard's "Your lines and the book's" and the PDF. A short part needs fewer words (`script.minWords`). The Urdu prompts in the Teacher PDF can't be extracted (broken font mapping) — if the client sends the Word file, Normal could show them as the book does.
- **Very easy** (`very_easy`, the fourth difficulty, for beginners): conversation scenarios use `VERY_EASY_PLAY` (one sentence of ≤12 words, common words) and the easy opening, and show the scenario's `academyLines` on screen during the call as "Useful sentences" (`scenario.helpLines`); scripted parts show the whole line. The examiner marks to the same descriptors but writes feedback in very simple English.
- Scenarios live in `config/coachScenarios.js`; a session stores a snapshot, so rewording never changes an old test. The character's hidden brief and the marking goals never reach the browser before the call ends.
- Frontend: `pages/EnglishCoachPage.jsx` (tabs: Practice / Team results / Settings) and `pages/EnglishCoachResultPage.jsx` (the scorecard). In `pages/englishCoach/`:
  - `PracticeTab.jsx`: a hero with tests left, average, best and streak; a live countdown with Resume / End for a call in progress; scenario cards with their own colour, icon and best score; trend and skills.
  - `CallRoom.jsx`: the call's state machine — all logic, no layout.
  - `CallStudio.jsx`: the call's look — a dark full-screen studio tinted by the scenario colour, with the voice orb, mic waveform, captions, transcript drawer, brief sheet, words meter and control dock.
  - `scenarioStyle.js`: each scenario's colour, icon and skill.
  - `useRecorder.js`: the mic stream and level history.
  - `voice.js` + `voice.worker.js`: Kokoro in a worker, falling back to the browser voice, then captions only.
  - `charts.jsx`: the score trend, area bars and `SkillRadar`.
  - `TeamTab.jsx` and `SettingsTab.jsx`.
  - The scorecard is a hero with ring, band, CEFR and change since the last call; sticky section links; the radar against the last call; range meters for each speaking figure; feedback cards; before/after corrections; and the transcript as a chat. It has a branded PDF via `pdf/coachScorecard.js`.
  - Vite builds workers as ES modules (`worker.format: 'es'`).
- Call lengths are set in Settings (allowed 3 / 5 / 10 / 15 min; new installs default to 3, 5, 10). The coach's own rate limits are per user, not per IP: 10 starts and 20 answers per minute.
- Team tab filters: `GET /portal/coach/sessions` takes `q` (person name/email or scenario title, matched literally) with `from`/`to`; `GET /portal/coach/overview` takes `from`/`to` or `all=1` (else `days`), and returns `bucket` (`day` for spans ≤ 62 days, else `week`) for its `weekly` series.
- Verify with `node scripts/smoke-english-coach.mjs` — 206 checks (incl. the scripted parts and Very easy), throwaway DB, providers stubbed, no server or keys needed.

### Satellite marketing sites (qurantutornow.com)
A second front end — `qurantutornow.com`, a Google Ads landing site living in a **separate repo** at `E:\CALCITE PROJECTS\quranTutor` (`asadawan16/QuranTutorFrontend`) — talks to this API. It has no backend, no portal and no checkout of its own.

- **CORS is a hardcoded allow-list** in `config/sites.js` (`isAllowedOrigin`), not a single `FRONTEND_URL`. A forgotten env var on a deploy host silently CORS-blocks a live marketing site, and that failure only shows up in a browser console. Whatever `FRONTEND_URL` points at is allowed too, so preview deploys keep working. Add a new front end there.
- **Payments redirect, they don't fork.** `POST /api/public/checkout` mints a Stripe `PaymentLink` and returns `{ payUrl }` = `${paySiteUrl()}/pay/:token`. The payer finishes on hidaya.online, so every Stripe session, return URL and webhook stays on ONE origin — a fourth landing site later needs zero Stripe work. Never run a second Stripe checkout on a satellite origin.
- **The browser never names an amount.** It sends `channel` + `planId` + `currency`; the money is looked up in `config/channelOffers.js`. Anything else means someone can POST `amount: 1`.
- **Channel prices are deliberately NOT the `Plan` collection.** qurantutornow publishes higher rates than hidaya.online because an ad lead is a different buyer. `config/channelOffers.js` is the authority; the satellite site fetches the same book via `GET /api/public/offers/:channel` so displayed price == charged price. The `PLANS` array in `quranTutor/src/data/content.js` is only that site's prerender fallback — **change a price in `channelOffers.js`, not there.**
- **Leads land in the existing Leads board.** Both `POST /api/public/trial` and every checkout attempt write an `Enrollment` with `source: 'qurantutornow'` (a new enum value). Checkout leads are deduped per email while still `status: 'new'`, so a payer who retries three times is one lead, not three.
- `PaymentLink.source` tags which funnel minted a link (`''` = staff-created in the portal/admin).
- Verify with `node scripts/smoke-public-checkout.mjs` — needs a **running server** (`npm run dev`) since it asserts real CORS headers; set any non-empty `STRIPE_SECRET_KEY` to exercise the checkout half.

### Discount Codes
- **Model** (`models/DiscountCode.js`): `code` (unique, uppercase, auto-generated if blank), `discountAmount`, `currency` (PKR/USD/EUR/GBP), `usageType` (one_time/recurring), `timesUsed`, `isActive`
- **Flow**: Admin creates a code → user enters it on payment link page (`/pay/:token`) → frontend validates via `POST /api/discount-codes/validate` → on Pay, code sent to backend → re-validates and deducts → on success, `timesUsed` increments
- **Presets**: PKR: 500/1000/1500/2000 · USD/EUR/GBP: 5/7/10/15 (plus custom amount)
- **Payment model** stores: `discountCode`, `discountCodeRef`, `discountAmount`, `originalAmount`

### Frontend API layers
- `src/utils/api.js` — public-facing `submitEnrollment()` function
- `src/admin/api.js` — admin API client with JWT Bearer token from `localStorage('admin_token')`
- `src/portal/api.js` — portal API client with JWT Bearer token from `localStorage('portal_token')`. Exports: `portalAuth`, `portalUsers`, `portalRoles`, `portalPermissions`, `portalMfa`, `portalStudents`, etc.

### Frontend context providers (Portal)
- `PortalAuthContext` — user state, login/logout, `hasPermission(perm)`, `hasRole(roleKey)`
- `SocketContext` — Socket.IO connection to `/portal` namespace
- `ToastContext` — toast notifications

### Design tokens (`src/index.css` @theme)
- Brand: `primary` (#0C3B2E dark green), `accent` (#D4A843 gold), `secondary` (#1B6B5A teal)
- Warm grounds: `paper` · `vellum` · `sand` · `night` — the marketing site alternates these instead of stacking near-whites
- Warm ink ramp: `ink`, `ink-900…ink-100`, plus `line` / `line-soft` hairlines. Don't use `text-neutral-*` on marketing pages
- Fonts: `font-display` (Source Serif 4), `font-body` (Inter), `font-mono` (DM Mono — all figures), `font-arabic` (Amiri)
- Recipes: `.eyebrow`, `.num`, `.card-warm`, `.toned` + `.tone-0/1/2`, `.lift-sm/md/lg/xl`, `.ground-hero`, `.glass-light`, `.glass-chip`, `.btn-sweep` variants
- Custom animations: `animate-marquee`, `animate-shimmer`, `animate-float`, `animate-glow`, `.orn` (the ornament's slow spin)
- Use Tailwind token classes (`bg-vellum`, `text-ink-500`, `border-line`) — never raw hex in JSX

**The full design system and the SEO/prerender pipeline are documented in `hidayah-frontend/CLAUDE.md`** — read it before touching a public page, `index.html`, `vercel.json` or the build scripts.

### SEO / prerendering (frontend)
`npm run build` in `hidayah-frontend/` is now three steps: client build → SSR build → `node prerender.mjs`. Every indexable marketing route is written to `dist/<route>/index.html` as complete static HTML with its own title, canonical, OG tags and JSON-LD, plus `sitemap.xml`, `robots.txt`, `404.html` and `app.html` (the SPA fallback for the portal/admin/pay routes). The page table lives in `src/seo/pages.js` — adding a landing page means one entry there and one route in `src/entry-server.jsx`.

### Data files (`src/data/`)
Static JS arrays for courses, FAQs, features, blog posts, and downloads. These are not fetched from the backend.

### Rate limiting
All limiters share a 15-min window via the `rl(max)` helper in `index.js`. Current caps: auth 100, payments/initiate 50, enrollments 100, subscribers/subscribe 50, payment-links/t 60, discount-codes/validate 100, class-links 300 (whole class shares one link at class time), portal/auth 100, portal/auth/forgot-password 10, portal/auth/reset-password 20.

### Background jobs
- **Payment cleanup**: Marks pending payments > 1 hour old as expired (runs on startup + every hour)
- **Log TTL**: MongoDB TTL index auto-deletes logs after 90 days