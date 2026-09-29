# Implementation Backlog

Ordered. Each item ships with migrations, validation, server-side authorization, tests
(including negative authorization tests) and documentation. Nothing is marked done until the
tests have actually been executed and the output recorded in the PR.

## Slice 0 — Foundation
- [ ] pnpm workspace, TypeScript strict, ESLint/Prettier, shared tsconfig
- [ ] `infrastructure/compose.yaml` — Postgres for local and CI
- [ ] `packages/database`: Drizzle setup, migration runner, per-test-database harness
- [ ] NestJS API skeleton: config loading, zod validation pipe, exception filter, request IDs, `/health`
- [ ] CI: lint, typecheck, migrate, test
- [ ] `.env.example` with placeholders only

**Exit:** `pnpm test` runs green against a real, freshly migrated Postgres, and CI reproduces it.

## Slice 1 — Tenancy and identity  *(first vertical slice per `10`)*
- [ ] Migration: districts, administrative_areas, schools, school_registration_requests, users,
      auth_identities, school_memberships, admin_scope_memberships, permissions, role_permissions,
      membership_permission_grants, user_sessions, audit_logs
- [ ] Public, rate-limited `POST /schools/registration-requests` (D-18)
- [ ] Approval workflow → creates school + unique school code + first admin membership, in one transaction
- [ ] Staff login, refresh-token rotation with reuse detection, logout, `/me`, `/me/schools`
- [ ] Policy layer + permission registry
- [ ] **Tests:** unapproved school cannot use academic endpoints · school code is unique ·
      admin of school A gets 404 on school B · refresh-token replay revokes lineage ·
      platform admin alone cannot read academic data

## Slice 2 — Academic structure and enrolment
- [ ] Migration: academic_years, grades, sections, subjects, class_subjects, students,
      enrollments (with effective dates, D-12), teacher_profiles, teacher_assignments,
      section_teachers (D-01)
- [ ] CRUD for years / grades / sections / subjects, scoped to the caller's school
- [ ] Student creation and enrolment; `UNIQUE(school_id, student_number)`
- [ ] Teacher assignment (subject) and class-teacher assignment (section)
- [ ] Composite FKs proving cross-school links are unrepresentable
- [ ] **Tests:** cross-school section enrolment rejected at the database level ·
      duplicate student number rejected · overlapping active enrolments rejected ·
      teacher of school A cannot read school B's roster

## Slice 3 — Guardian linking
- [ ] Migration: guardians, student_guardians (relationship_type here, D-07), consent_records
- [ ] Parent phone + OTP activation against an `SmsProvider` interface (dev = log, Q4)
- [ ] School-side verification and revocation of links
- [ ] `/parents/me/children`
- [ ] **Tests:** parent cannot read an unlinked child (404) · multiple linked children work ·
      revoked link blocks the **next** request with no waiting period ·
      no endpoint enumerates students by id

## Slice 4 — Attendance
- [ ] Migration: attendance_statuses (per-school config), attendance_sessions
      (session_ordinal + optional class_subject, D-10), attendance_records,
      attendance_change_log
- [ ] Open session → roster resolved from enrolments covering that date (D-12)
- [ ] Transactional submission, idempotency key, retry-safe
- [ ] Correction workflow: old value, new value, reason, actor, timestamp
- [ ] Student self-read and parent read of linked child only
- [ ] **Tests:** duplicate submission is idempotent, not duplicated · unmarked pupil has **no**
      record and is never reported absent (D-11) · unassigned teacher denied · correction
      without reason rejected · correction writes an audit row · failed submission leaves the
      session unsubmitted · parent sees exactly one child

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
