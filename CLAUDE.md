# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hidaya Online — a full-stack web application for an online Quran learning academy. Monorepo with two independent packages: a React SPA frontend and an Express/MongoDB REST API backend.

This root folder is **not** a git repository — `hidayah-frontend/` and `hidayah-backend/` each are, separately. Run `git` inside one of those, never here.

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
- `smoke-*.mjs` — end-to-end smoke tests per feature (chat, fees, sockets, schedule-board, notifications, notice-roles, payment-link-tax, stripe-payments, fee-gateway, public-checkout, student-progress, class-links, new-features). Note: `smoke-batch.mjs` and the socket/chat/notification smokes hit a **running server** over HTTP (`PORT`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`) — start `npm run dev` first; the others connect straight to Mongo.
- `import-*.mjs` — one-off data importers (students, daily/permanent lessons, tutor-changes). These read the spreadsheet path from `STUDENTS_XLSX`, not a hardcoded file.
- `reset-students.mjs` — wipes + reseeds only student records (narrower than `reset-db.mjs`); `pick-student.mjs` prints a student for ad-hoc inspection
- `migrate-*.mjs` — idempotent data migrations (e.g. `migrate-add-complaint-perms.mjs` backfills a new permission onto existing roles); run once after pulling a schema/permission change
- `students-lib.mjs` / `tutor-lib.mjs` — shared helpers (`loadAllModels`, etc.) used by the above

## Environment variables (`hidayah-backend/.env`)

There is no `.env.example`; the running `.env` is the source of truth. Keys consumed by the code:

- **Core:** `MONGODB_URI`, `PORT` (default 5000), `JWT_SECRET` (signs BOTH admin and portal tokens), `FRONTEND_URL` (CORS allow-list + links in emails/payment callbacks), `MFA_ENCRYPTION_KEY` (encrypts stored TOTP secrets)
- **Seed admin:** `ADMIN_EMAIL`, `ADMIN_PASSWORD` (used by `seed.js` / `reset-db.mjs`)
- **SMTP (mailer):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_EMAIL` (internal notification recipient)
- **Mastercard gateway:** `MC_API_USERNAME`, `MC_API_PASSWORD`, `MC_GATEWAY_URL`, `MC_MERCHANT_ID`
- **Stripe gateway:** `STRIPE_SECRET_KEY` (absence disables Stripe checkout entirely — the API returns 503), `STRIPE_WEBHOOK_SECRET` (`whsec_…` for the endpoint registered at `POST /api/stripe/webhook`; locally `stripe listen --forward-to localhost:5000/api/stripe/webhook` prints one)
- **AWS S3 (blog images / uploads):** `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `PRESIGN_EXPIRES`
- **Misc:** `CSP_ENABLED` (toggles Helmet CSP), `STUDENTS_XLSX` (import scripts), `PAY_SITE_URL` (optional — where `/pay/:token` lives when it differs from `FRONTEND_URL`; falls back to `FRONTEND_URL`, then the literal `https://hidaya.online`)

> CORS is **not** driven by env — it's the hardcoded allow-list in `config/sites.js`. See Satellite marketing sites.

Frontend uses only `VITE_API_URL` (defaults to `http://localhost:5000/api`).

## Tech Stack

**Frontend:** React 19, React Router v7 (BrowserRouter), Vite 8, Tailwind CSS v4 (via `@tailwindcss/vite` plugin — no tailwind.config.js), Framer Motion, GSAP + ScrollTrigger, Lucide React, Chart.js + react-chartjs-2, Socket.IO client. Marketing routes are prerendered to static HTML at build time (see SEO below). Three.js was removed — it only drew a login background.

**Backend:** Express 4 (ES modules), Mongoose 8 / MongoDB, JWT auth (jsonwebtoken + bcryptjs), Nodemailer (SMTP), Mastercard Payment Gateway Integration, Socket.IO, Helmet + CORS + express-rate-limit, AWS S3 (blog images), otplib + qrcode (MFA/TOTP)

## Architecture

### Two-app structure
Frontend and backend are separate npm projects with independent `node_modules`. They communicate over REST — the frontend reads `VITE_API_URL` env var (defaults to `http://localhost:5000/api`). Backend allows the frontend origin via `FRONTEND_URL` env var in CORS config.

### Frontend routing (`src/App.jsx`)
All pages are lazy-loaded. Four layout contexts determined by `location.pathname`:

- **Public routes** — wrapped in `PublicLayout` (Navbar → main → Footer → WhatsAppFloat): `/`, `/about`, `/courses`, `/fee`, `/faqs`, `/contact`, `/free-class`, `/downloads`, `/refund-policy`, `/privacy-policy`, `/blog`, `/blog/:slug`, `/payment/callback`
- **Pay routes** — bare layout (no nav): `/pay/:token`, `/pay/:token/callback`
- **Admission** — standalone: `/admission` (public admission form, no portal auth)
- **Class links** — standalone, UNLISTED: `/class-links` (public meeting-link board shared with students; no nav entry anywhere, `noindex`, optional access code — managed at `/portal/class-links`)
- **Admin routes** — wrapped in `ThemeProvider`, guarded by `RequireAuth`: `/admin/login`, `/admin/dashboard`, `/admin/payments`, `/admin/enrollments`, `/admin/payment-links`, `/admin/discount-codes`, `/admin/plans`, `/admin/students`, `/admin/blogs`, `/admin/subscribers`, `/admin/export`, `/admin/payment-settings`, `/admin/logs`
- **Portal routes** — wrapped in `ThemeProvider` + `PortalAuthProvider` + `SocketProvider` + `ToastProvider`, guarded by `RequirePortalAuth` with permission checks: `/portal/login`, `/portal/dashboard`, `/portal/users`, `/portal/roles`, `/portal/students`, `/portal/students/:id`, `/portal/tutors`, `/portal/admissions`, `/portal/curriculum`, `/portal/schedule`, `/portal/attendance`, `/portal/lessons`, `/portal/chat`, `/portal/assessments`, `/portal/notices`, `/portal/finance`, `/portal/reports`, `/portal/my-classes`, `/portal/my-progress`, `/portal/profile`, `/portal/leads`

### Two separate auth systems
1. **Admin auth** — `middleware/auth.js` verifies JWT, sets `req.adminId`. Token stored in `localStorage('admin_token')`. API client at `src/admin/api.js`.
2. **Portal auth** — `middleware/portalAuth.js` verifies JWT with `type: 'portal'`, loads User with populated roles, builds `req.userPermissions` (Set). Token stored in `localStorage('portal_token')`. API client at `src/portal/api.js`. Supports MFA (TOTP via otplib).

### RBAC (Portal)
- Permissions defined in `config/permissions.js` as flat `domain.action` strings (e.g. `student.read`, `lesson.log`)
- `requirePermission(...perms)` middleware factory checks all specified permissions are present
- Default roles: `super_admin`, `admin`, `principal`, `coordinator`, `qci`, `qcm`, `tutor`, `student`
- Frontend `RequirePortalAuth` component accepts a `permission` prop to gate routes

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
- `/class-links` — PUBLIC (no auth): `GET /public` (active links, optional `?code=`) + `POST /:id/click`
- `/stripe/webhook` — PUBLIC, **raw body**, signature-authenticated (see Payment gateways). Mounted directly in `index.js`, not via a router, because it must precede `express.json()`.
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
- `/portal/finance` — invoices + salary records
- `/portal/families` — family records (`portalFamilyRoutes`)
- `/portal/leads` — lead management
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
- `/portal/class-links` — the public class-links board + its page settings (`class_link.read`/`class_link.manage`, super-admin only by default)

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
- `activityLogger.js` — writes `Log` documents for audit trails
- `cleanupPayments.js` — the pending-payment expiry background job (see Background jobs)
- `totp.js` — TOTP secret encryption/verification for portal MFA (uses `MFA_ENCRYPTION_KEY`)

### Backend models
Core: `Admin`, `User` (portal), `Role`, `Student`, `StudentStatusHistory`, `TutorProfile`, `StaffProfile`, `Family`, `StudentRelationship`
Academic: `ClassSlot`, `ClassSession`, `PermanentLesson`, `LessonEntry`, `CurriculumItem`, `Assignment`, `TutorChangeRequest`, `Assessment`, `AssessmentTemplate`, `TutorAttendance`, `ScheduleConfig`, `ShiftConfig`
Business: `Payment`, `PaymentLink`, `Plan`, `DiscountCode`, `Invoice`, `FeePayment`, `StudentFeeRecord`, `SalaryRecord`, `SalaryIncrement`, `Advance`, `Expense`, `Enrollment`, `AdmissionApplication`, `DemoTrial`
HR/recognition: `LeaveRequest`, `EmployeeOfMonth`, `Badge`, `Certificate`
Communication: `ChatThread`, `Message`, `Notice`, `Complaint`, `Notification`, `WhatsappReminderLog`, `ClassLink`, `ClassLinkSettings`
Content: `BlogPost`, `Subscriber`, `Log`
Infrastructure: `StripeEvent` (webhook idempotency ledger, 30-day TTL), `PaymentSettings` (singleton — which gateway the fee page uses)

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