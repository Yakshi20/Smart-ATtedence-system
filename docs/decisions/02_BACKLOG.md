# Implementation Backlog

Ordered. Each item ships with migrations, validation, server-side authorization, tests
(including negative authorization tests) and documentation. Nothing is marked done until the
tests have actually been executed and the output recorded in the PR.

## Slice 0 — Foundation  ✅ complete
- [x] pnpm workspace, TypeScript strict, ESLint/Prettier, shared tsconfig
- [x] `infrastructure/compose.yaml` — Postgres for local and CI
- [x] `packages/database`: Drizzle setup, migration runner, per-test-database harness
- [x] NestJS API skeleton: config loading, zod validation pipe, exception filter, request IDs, `/health`
- [x] CI: lint, build, typecheck, migrate (twice), test
- [x] `.env.example` with placeholders only

**Exit criteria met.** Verified locally against PostgreSQL 16.15: `pnpm lint`,
`pnpm -r build`, `pnpm typecheck`, `pnpm db:migrate` (idempotent on a second run) and
`pnpm test` — 42 tests across 7 suites, no orphaned databases left behind.
CI reproduces the same sequence but has **not yet been observed running** — the workflow
is committed and unexercised until the first push to GitHub.

## Slice 1 — Tenancy and identity  ✅ complete (uncommitted, awaiting review)
- [x] Migration `0001_tenancy_identity.sql`: users, auth_identities, schools,
      school_registration_requests, platform_memberships, school_memberships, user_sessions,
      refresh_tokens, account_activation_tokens, audit_logs (append-only trigger).
      **Deferred, with reasons in `01 §8`:** districts, administrative_areas,
      admin_scope_memberships, permissions, role_permissions, membership_permission_grants
- [x] Public, rate-limited `POST /schools/registration-requests` (D-18) — quarantined, stays `pending`
- [x] Approval / rejection (platform permission only, Q2) → school + unique code + admin
      membership + activation token + audit, in one transaction; concurrent approvals serialized
- [x] Staff activation, login, refresh-token rotation with reuse detection, logout, `/me`, `/me/schools`
- [x] Policy layer (`AccessService`, branded `SchoolScope`, default-deny guard) + permission
      registry (`packages/permissions`)
- [x] School-scoped staff list / invite, to exercise role permissions and isolation
- [x] Operator CLI `platform-admin:create`; no HTTP route can grant a platform role
- [x] **Tests** (all against real PostgreSQL):
      school code is unique (DB constraint + 12 approvals) ·
      admin of school A gets 404 on school B, identical to a non-existent school ·
      refresh-token replay revokes the lineage, including the legitimate client's newer tokens ·
      platform admin alone cannot read school data ·
      public registration cannot self-approve or gain a role ·
      a revoked membership / suspended school / disabled account is blocked on the next request ·
      teacher 403 vs outsider 404 · login failures indistinguishable · public route inventory pinned
- [x] "Unapproved school cannot use academic endpoints" — an unapproved request has no school
      row, user or credential; and a school row in `pending` status gets 404 on every academic
      route (`structure.integration.test.ts`, added in Slice 2)

**Verification (2026-09-29, local PostgreSQL 16.15):** `pnpm lint` clean · `pnpm -r build` ·
`pnpm typecheck` clean · `pnpm db:migrate` applied `0001` to the dev database, and a second
run was a no-op · `pnpm test` — **186 tests in 18 suites** (permissions 12, shared 27,
database 37, api 110), no orphaned test databases. CI still not observed running.

### Slice 1 follow-ups (not blocking Slice 2)
- [ ] Real email provider for `AccountNotifier` — **needs your choice; production cannot start without one**
- [ ] Re-issue activation token (admin / platform action) when delivery fails or a token expires
- [ ] Password reset flow (`/auth/password/reset`)
- [ ] Membership revocation endpoint (revocation is enforced, but only settable in SQL today)
- [ ] Shared rate-limit store (Redis) before running more than one API instance
- [ ] OpenAPI generation from the zod schemas (`docs/api/README.md` is hand-maintained)
- [ ] Session / refresh-token retention cleanup job
- [ ] Stronger authentication for platform admins (`07 §1`), e.g. TOTP

## Slice 2 — Academic structure and enrolment  ✅ complete (uncommitted, awaiting review)
- [x] Migration `0002_academic_structure.sql`: academic_years, grades, sections, subjects,
      class_subjects, students, student_number_counters, enrollments (effective dates, D-12),
      teacher_assignments. **teacher_profiles deferred:** the school membership already is the
      teacher's identity in the school; a profile table has no Slice 2 field to hold
- [x] Academic years with lifecycle planned → active → closed → archived; overlap and
      one-active rules enforced by the database
- [x] Grades (Classes 1–7), sections (school-chosen names), subjects (codes + en/kn labels),
      class-subjects (per section or whole grade)
- [x] Students; `UNIQUE(school_id, student_number)`; supplied or generated numbers; status
      active / transferred / withdrawn
- [x] Enrolments: enrol, section transfer, void, promotion (batch, all-or-nothing), withdrawal /
      transfer-out, roster by date, history — immutable rows enforced by triggers
- [x] Teacher assignment to class-subject; relationship-based student/roster visibility
- [x] Composite FKs proving cross-school and cross-year links are unrepresentable
- [x] **Tests:** cross-school section / class-subject / enrolment / assignment rejected at the
      database level (raw SQL) and by the API · duplicate grade, section, subject,
      class-subject, student number and enrolment rejected · overlapping and concurrent
      enrolments rejected · invalid date ranges rejected · promotion and transfer retain
      history · teacher of school A cannot read school B's roster · unassigned teacher 403 on
      roster, 404 on students · pending/suspended school 404 on academic routes ·
      0002 upgrade over Slice 1 data, idempotent re-run

**Verification (2026-09-30, local PostgreSQL 16.15):** `pnpm lint` clean · `pnpm -r build` ·
`pnpm typecheck` clean · `pnpm db:migrate` applied `0002` to the dev database, and a second run
was a no-op (checksums `7c28c3b78c70` / `7b69cfa585e4` match the files) · `pnpm test` —
**305 tests in 24 suites** (permissions 15, shared 46, database 76, api 168), no orphaned test
databases. CI still not observed running.

### Slice 2 follow-ups
- [ ] Rename / delete-while-empty for grades and sections (only create exists)
- [ ] Bulk student import (`06 §2` `/students/import`)
- [ ] Privileged, audited "reopen closed year" process, if schools need it
- [ ] Enrolment corrections after attendance exists: voiding must then be blocked or cascade (Slice 4)
- [ ] Gender / category fields for district reporting — needs a documented purpose (07 §4)
- [ ] Kannada labels in `SUGGESTED_SUBJECTS` need native-speaker review

## Slice 3 — Guardian linking  ✅ complete (uncommitted, awaiting review)
- [x] Migration `0003_guardians.sql`: guardians (per school), student_guardians
      (relationship_type on the link, D-07), guardian_link_claims, otp_challenges;
      `auth_identities` widened for `phone_otp`. **consent_records deferred** until the legal
      review defines purposes (07 §3)
- [x] Parent phone + OTP against an `SmsProvider` interface — dev adapter is memory-only,
      **never logs codes** (Q4 amended), refuses production; `none` → honest 503
- [x] School-side guardian records; initiate, verify, reject, revoke links; review queue with
      conflicting-claim count; self-approval blocked
- [x] Parent link requests (enumeration-safe), `/parents/me/children`, `/parents/me/children/:id`
- [x] **Tests:** parent cannot read an unlinked child (404, identical to a random id) · pending and
      rejected links expose nothing · multiple children and multiple guardians work · one phone
      across two schools · revoked link blocks the **next** request on the same token · suspended
      school drops out · cross-school link rejected by API and database · concurrent
      verification → one winner · OTP expiry, replay, attempt cap, lockout, cooldown, concurrent
      correct codes, identical failure responses, code absent from DB text and server output ·
      no endpoint enumerates students by id

**Verification (2026-09-30, local PostgreSQL 16.15):** `pnpm lint` clean · `pnpm -r build` ·
`pnpm typecheck` clean · `pnpm db:migrate` applied `0003` to the dev database, and a second run
was a no-op (checksums `7c28c3b78c70` / `7b69cfa585e4` / `678d3c566020` match the files) ·
`pnpm test` — **375 tests in 29 suites** (permissions 16, shared 55, database 97, api 207), no
orphaned test databases. **CI still not observed running.**

### Slice 3 follow-ups
- [ ] **Choose an SMS provider** (owner decision: cost, TRAI DLT registration, data processing
      agreement). Until then parent login works only in automated tests
- [ ] Consent records once purposes/lawful basis are defined (legal review)
- [ ] Maker–checker for guardian-claim links (reviewer ≠ second approver)
- [ ] Phone-number change / re-verification policy for recycled numbers
- [ ] Guardian display-name self-service (accounts are created as "Guardian")
- [ ] Kannada SMS template; OTP challenge retention cleanup
- [ ] Teacher read access to guardian contacts of assigned sections, if schools need it

## Slice 4 — Attendance  ✅ complete (uncommitted, awaiting review)
- [x] Migration `0004_attendance.sql`: attendance_sessions (class_subject_id NOT NULL + period,
      per Q1; one register per section/date/period), attendance_records, attendance_corrections
      (the backlog's attendance_change_log). **attendance_statuses (per-school config) deferred:**
      fixed `present/absent/late/approved_leave` from FR-007
- [x] Open a register for an assigned class-subject → roster resolved from enrolments covering
      the date (D-12), via one shared resolver
- [x] Whole-roster transactional submission, `Idempotency-Key`, retry-safe
- [x] Corrections: old value, new value, reason, actor, timestamp; admins only; append-only
- [x] Enrolment void / end refused when it would contradict recorded attendance (DB trigger)
- [x] Parent read of a verified-linked child. **Student self-read not built** — no student login
      linkage exists (D-05 deferred); documented rather than invented
- [x] **Tests:** roster by date across joins, transfers and withdrawals · duplicate submission is
      idempotent, not duplicated · conflicting payload with a reused key → 409 · unmarked pupil
      has **no** record and is never counted absent (D-11) · unassigned teacher denied (and a
      mutation test proves the check matters) · cross-school 404 · correction without reason
      rejected · correction appends history and an audit row · failed submission (incl. a
      mid-batch DB failure) leaves the session unsubmitted with no records · parent sees only the
      verified child, loses access on revocation · closed and planned years refuse attendance ·
      future and too-old dates refused · attendance blocks enrolment void / early end at API and
      DB level

**Verification (2026-09-30, local PostgreSQL 16.15):** `pnpm lint` exit 0 · `pnpm -r build` exit 0 ·
`pnpm typecheck` exit 0 · `pnpm test` exit 0 — **430 tests in 32 suites** (permissions 17,
shared 63, database 116, api 234), no orphaned test databases · `pnpm db:migrate` applied `0004`
to `smartschool_dev`, and a second run was a no-op; all four file checksums match the ledger.
**CI still not observed running.**

### Slice 4 follow-ups
- [ ] Teacher correction *requests* approved by an admin (Q1 maker–checker)
- [ ] Per-school configurable statuses, if schools need more than the four
- [ ] Holiday / weekend checks once the calendar exists (D-16)
- [ ] Attendance reports by school / year / class / section / date range (FR-007) and completeness
      (records vs roster)
- [ ] Student self-view once students can log in (D-05)
- [ ] Parent notifications after submission (queue, Slice 5+)
- [ ] Elective split-periods if a school needs them (relax the slot key)

## Slice 5+ — Deferred
Timetables · homework and materials · calendar with precedence (D-16) · exams, marks,
publication, report cards · notifications and queue · imports/exports · district portal ·
RLS · i18n QA · accessibility · load testing.

## Cross-cutting, tracked but not yet scheduled
- [ ] Support access grants + break-glass audit (D-04)
- [ ] Row-level security as a fourth isolation layer
- [ ] Data retention and deletion configuration
- [ ] Backup and restore drill
- [ ] Legal review of DPDP obligations — **blocking for production, not for development**
