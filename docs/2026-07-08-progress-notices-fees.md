# Feature Delivery — Student Progress, Management Notices, Fee Management

**Date:** 2026-07-08
**Branch:** `main` (both `hidaya-backend` and `hidaya` frontend repos)
**Status:** ✅ Implemented, smoke-tested (31/31 assertions), committed & pushed.

This document summarizes three features plus supporting fixes so they can be reviewed later.

---

## 1. Student Progress page (staff/tutor-facing education view)

A read-only page for staff and tutors to understand a student's education end-to-end.
Distinct from the student's own `/portal/my-progress`.

### Behaviour
- **List** at `/portal/student-progress` → click a student → **detail** at `/portal/student-progress/:id`.
- **Scope:** tutors see only students they are actively assigned to (via `Assignment` where `endDate: null`); management (super_admin, admin, principal, coordinator, qci, qcm) see all.
- **Curriculum with overdue red flags:** each `CurriculumItem` now has an `expectedDays` field. Overdue is computed **cumulatively from the student's joining date** — items are walked in track order, `expectedDays` summed to a due date; an item past its due date with **no approved `PermanentLesson`** is flagged 🔴. `expectedDays: 0` = untracked ⇒ never flagged (so no false reds until configured per item).
- Also shows: last 10 classes (on-time / late / absent), absence + late counts, assessments, badges, certificates, current tutor(s), and complaints split into **management-initiated** vs **parent** (see §4).
- **Excludes all billing/fee data** — education view only.

### Permission
- New `student_progress.read`.
- Granted to: super_admin, admin, principal, coordinator, qci, qcm, **tutor**.
- **NOT** granted to `student` (they keep `/my-progress`). The permission exists so it can be enabled for students later if desired.

### Backend
- `models/CurriculumItem.js` — added `expectedDays: Number (default 0)`.
- `controllers/portalCurriculumController.js` — create/update accept `expectedDays`.
- `controllers/portalStudentProgressController.js` — **new**. `listProgressStudents`, `getStudentProgressDetail`.
- `routes/portalStudentProgressRoutes.js` — **new**, mounted at `/api/portal/student-progress`.
- `index.js` — route mounted.

### Frontend
- `src/portal/api.js` — `portalStudentProgress { list, get }`.
- `src/portal/pages/StudentProgressPage.jsx` — **new** (students table).
- `src/portal/pages/StudentProgressDetailPage.jsx` — **new** (detail view).
- `src/portal/pages/CurriculumPage.jsx` — "Expected days to learn" field in the item form.
- `src/App.jsx` — routes gated by `student_progress.read`.
- `src/portal/components/PortalLayout.jsx` — nav item under **Academic**.

---

## 2. Notices → management roles

Notices could previously target only **all tutors** or **all students**. Now they can target specific portal roles.

### Behaviour
- New **"Specific Roles"** audience in the notice composer with a role multi-select (Super Admins, Admins, Principal, Coordinator, QCI, QCM, Tutors).
- A role-targeted notice is delivered **only** to users holding one of those roles, and each such user gets an in-app notification.
- Global "All Staff / All Students" notices still reach everyone; legacy notices (no `targetRoles` field) are unaffected (regression-verified).

### Backend
- `models/Notice.js` — added `targetRoles: [String]`.
- `controllers/portalNoticeController.js`:
  - `createNotice` stores `targetRoles` and notifies users holding those roles.
  - `getActiveNoticesForUser` delivers role-targeted notices to matching roles; the global-broadcast clauses now exclude role-targeted notices.

### Frontend
- `src/portal/pages/NoticesPage.jsx` — "Specific Roles" audience + role picker; sends `targetRoles`.

---

## 3. Manual Fee Management

Fees are **not** auto-captured from the payment gateway (bank transfers / cash / mixed modes are common), so this is a manual yearly grid. **v1 — to be refined against the client's Excel sheet + screenshot.**

### Behaviour (`/portal/fees`)
- **Yearly grid:** students × 12 months. Each cell = a status (received / partial / pending / waived) + amounts. Click a cell to edit. Year switcher, search.
- **Log Payment:** one payment allocated across **many months and many students** (family relations). Auto-creates missing month cells and computes received/partial from expected vs paid.
- **Link existing gateway payment:** search unlinked completed card/online payments and attach one to fee months (prefills amount/payer/currency).
- **Payments log:** lists recorded payments; delete **rolls back** the affected month cells.

### Data model
- `models/StudentFeeRecord.js` — **new**. One cell per `{ studentId, year, month }`: `amount`, `amountPaid`, `currency`, `status`, `payments[]`, `method`, `note`, `paidAt`. Unique index on `{ studentId, year, month }`.
- `models/FeePayment.js` — **new**. A received payment with `allocations: [{ studentId, year, month, amount }]`, `method`, `reference`, `payerName`, `familyId`, optional `linkedPaymentId` (wraps a gateway `Payment`).

### Permission
- New `fee.read`, `fee.manage`.
- Granted to: super_admin, admin, qci, qcm. (Deliberately a dedicated permission so QCI/QCM get fee access without the broader `finance.*`.)

### Backend
- `controllers/portalFeeController.js` — **new**: `getFeeGrid`, `upsertFeeCell`, `createFeePayment`, `listFeePayments`, `deleteFeePayment`, `listLinkablePayments`.
- `routes/portalFeeRoutes.js` — **new**, mounted at `/api/portal/fees`.

### Frontend
- `src/portal/api.js` — `portalFees { grid, updateCell, listPayments, createPayment, deletePayment, linkablePayments }`.
- `src/portal/pages/FeeManagementPage.jsx` — **new** (grid + cell editor + log/link payment + payments log).
- `src/App.jsx` — route gated by `fee.read`.
- `src/portal/components/PortalLayout.jsx` — "Fee Management" nav item under **Finance**.

---

## 4. Complaints on the progress page

- **Management-initiated** = `complainant === 'other' | 'student'` OR `category ∈ { admin_feedback, quality_issue }`.
- **Parent** = `complainant ∈ { father, mother, grandfather, grandmother, uncle, aunty, brother, sister }`.
- Both are surfaced on the student progress detail, with the tutor the complaint is against.

## 5. Bug fix — phantom `complaint.resolve` permission

The Complaints **Resolve** button in `NoticesPage` was gated by `complaint.resolve`, which does not exist in the catalog ⇒ never granted ⇒ button never showed. Aligned it to `notice.manage` (what the backend resolve route enforces, and what `ComplaintsPage` already uses).

---

## Permission changes summary

| Permission | New? | Granted to |
|---|---|---|
| `student_progress.read` | ✅ | super_admin, admin, principal, coordinator, qci, qcm, tutor |
| `fee.read`, `fee.manage` | ✅ | super_admin, admin, qci, qcm |

> Roles were re-seeded in the dev DB (`node seedPortal.js`) so these are live. For production, run the same seed **or** grant the new permissions per-role via the Roles admin page (re-seeding overwrites manual role tweaks).

---

## API endpoints added

```
GET    /api/portal/student-progress            student_progress.read   (tutor-scoped)
GET    /api/portal/student-progress/:id         student_progress.read

GET    /api/portal/fees/grid                    fee.read
GET    /api/portal/fees/payments                fee.read
GET    /api/portal/fees/linkable-payments       fee.read
PATCH  /api/portal/fees/cell                     fee.manage
POST   /api/portal/fees/payments                fee.manage
DELETE /api/portal/fees/payments/:id             fee.manage
```
Notices reuse existing `/api/portal/notices/*` endpoints (now accept/deliver `targetRoles`).

---

## Testing

Backend smoke scripts (run against the dev DB; create temp data and clean up):

```
node scripts/smoke-student-progress.mjs   # 12 assertions — overdue logic, scope, billing exclusion, complaints split
node scripts/smoke-notice-roles.mjs       # 8  assertions — role delivery + global regression
node scripts/smoke-fees.mjs               # 11 assertions — allocations, partial/waived, grid, rollback
```
All 31 pass. Live server confirmed all new routes mount and return 401 unauthenticated. Frontend production build passes; changed files lint clean (pre-existing `App.jsx` `TopBar` warning is unrelated).

---

## Decisions made (delegated to best judgement)

1. **Overdue logic:** cumulative from joining date (vs simple per-item elapsed).
2. **Tutor scope on progress:** tutors see only their assigned students.
3. **Fee Management:** built a v1 now from the written description; schema kept flexible.

## Follow-ups / open items

- **Fee Management refinement** once the client's **Excel sheet + screenshot** are shared (exact statuses, per-family layout, agreed-fee defaults, any yearly totals/breakdowns).
- Optionally enable the progress page for the `student` role later (permission already exists).
- Optional: introduce a properly separated `complaint.resolve` permission (currently unified under `notice.manage`) if QCI/coordinators should resolve complaints without full notice management.
- `expectedDays` must be configured on curriculum items before any overdue reds appear (0 by default = untracked).
