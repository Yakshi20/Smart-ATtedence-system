# Analysis — Contradictions, Gaps and Open Decisions

Status: **awaiting sign-off**
Reviewed inputs: `docs/blueprint/00`–`10`
Date of analysis: 2026-09-29

This document records every place where the blueprint is self-contradictory, under-specified,
or specifies something the logical schema in `05_DATABASE_SCHEMA.md` cannot express.
Each item has a **recommended resolution**. Items marked **BLOCKER** change the Slice 1
database schema and must be settled before migrations are written; the rest can be
deferred without rework.

Legend — `B` blocker for Slice 1 · `I` important, affects a later slice · `M` minor / hygiene

---

## A. Authorization model

### D-01 (B) — "Teacher assigned to class-subject" cannot authorize a section-level attendance register

`02 §3` and `FR-006` scope a teacher to a **class-subject** (`teacher_assignments` →
`class_subjects` → section + subject). But `FR-007` lets a teacher open attendance for an
"assigned class/date", and `attendance_sessions` is keyed on **section**, with no subject.
A subject-level assignment therefore never authorizes a section-level daily register, yet
daily attendance is the primary workflow.

The blueprint has no concept of a **class teacher / homeroom teacher**, which is how Indian
primary schools actually take daily attendance.

**Recommended:** introduce an explicit `section_teachers` relation (section, teacher,
role = `class_teacher` | `assistant`, effective dates). Daily/section-level attendance is
authorized by `class_teacher`; period-level attendance (if a school enables it) is
authorized by `teacher_assignments` on the matching `class_subject`. Both paths resolve
through one policy function, never by role name.

### D-02 (B) — Fixed `role_permissions` cannot express "only if explicitly granted"

`05` models permissions as `role_permissions(role, permission_id)` — a global,
role-to-permission map. But `02 §3` requires per-person grants: *"Publish marks | Teacher |
Only if explicitly granted"*, and *"Manage class rosters | Teacher | Assigned if granted"*.
A global role map cannot say "teacher A may publish, teacher B may not".

Separately, `role_permissions.role` is a bare string while roles live in **two** namespaces
(`school_memberships.role` and `district_memberships.role`), so the table is ambiguous.

**Recommended:** keep `role_permissions` as the **default** grant per (scope_type, role),
and add `membership_permission_grants(membership_id, permission_key, granted, granted_by,
reason, expires_at)` as an explicit allow/deny overlay. Effective permission =
role default, overridden by membership grant. Scope type (`school` | `district` | `platform`)
becomes an explicit column so the two role namespaces stop colliding.

### D-03 (I) — District officers need area-level scope, not only district-level

`administrative_areas` exists with `area_type`, and Karnataka's real hierarchy has
block/taluk officers (BEO) below district officers (DDPI). But only
`district_memberships` exists — there is no area-scoped membership, so a block officer
would have to be given a whole district.

**Recommended:** generalize to `admin_scope_memberships(user_id, scope_type, scope_id, role,
status)` where `scope_type ∈ {district, area}`, and resolve a school into the caller's
scope by walking `schools.area_id → administrative_areas.parent_area_id*`.

### D-04 (I) — Platform "break-glass" access is required by `07 §5` but not modelled

`FR-014` and `07 §5` require support access to be purpose-limited, approved, time-bound and
audited. `05` has no table for it, so the only implementable options are "platform admin sees
everything" (violates the non-negotiables) or "platform admin sees nothing" (support is
impossible).

**Recommended:** `support_access_grants(actor_user_id, school_id, purpose, approved_by,
granted_at, expires_at, revoked_at)`. Platform role grants **zero** academic read access on
its own; an active grant is what the policy layer checks, and every read under a grant is
written to `audit_logs`.

---

## B. Identity

### D-05 (B) — `students` has no link to `users`, so students cannot log in

`teacher_profiles` has a `user` column and `guardians` has a `user` column, but `students`
does not. Yet `FR-002` requires students to sign in (school code + student ID + password/PIN)
and `/students/me` must resolve an authenticated caller to a student row.

**Recommended:** `students.user_id` nullable (a student record exists from enrolment; the
login account appears only at activation), `UNIQUE(user_id)`, plus a `school_memberships`
row with role `student`. Nullable is deliberate — Class 1 pupils may never get an account,
and the roster must not depend on one.

### D-06 (B) — Student login is school-scoped but `users` is global

`school code + student ID + password` identifies a student **within a school**, while `users`
is a global table. Undefined: when a pupil transfers from school A to school B, is that the
same `users` row with a new `students` row, or a new identity?

**Recommended:** one `users` row per human, one `students` row per (school, student_number).
Transfer creates a new `students` row in the receiving school linked to the **same**
`users` row, and the old `school_memberships` row is set to `inactive` rather than deleted —
so history stays readable and the child keeps one login. School code in the login payload
selects *which* student record to resolve, and is treated as a routing hint, never as a secret
(per non-negotiable 8).

### D-07 (B) — `guardians.relationship_type` is on the wrong table

`05` puts `relationship type` on `guardians` (the person). But a person is "mother" *of a
specific child*; a guardian linked to two children can hold different relationships, and
`FR-005` explicitly allows a guardian linked to multiple children.

**Recommended:** move `relationship_type` to `student_guardians`. `guardians` keeps only
person-level identity/verification state.

### D-08 (I) — `/auth/login` is one endpoint for three incompatible credential shapes

`06 §1` lists a single `POST /auth/login`, but the blueprint defines student
(code + ID + password), parent (phone + OTP) and staff (email + password) flows. A single
body schema cannot validate all three without becoming permissive.

**Recommended:** keep `POST /auth/login` as a discriminated union on a required
`method ∈ {student_password, staff_password, phone_otp}`, validated per-variant. One route
keeps the OpenAPI surface as specified while validation stays strict.

### D-09 (I) — `user_sessions` cannot support secure refresh

`/auth/refresh` must be "secure", but `user_sessions` stores only created/expiry/revocation
timestamps — no token hash, no rotation lineage, so replay of a stolen refresh token is
undetectable.

**Recommended:** store `refresh_token_hash` (SHA-256 of a 256-bit random token; never the
token), `parent_session_id` for rotation lineage, and `reused_at`. On reuse of an already-
rotated token, revoke the whole lineage and audit it. Access tokens stay short-lived JWTs;
refresh tokens are opaque and single-use.

---

## C. Attendance

### D-10 (B) — `attendance_sessions` has no uniqueness key that supports multiple sessions per day

`FR-007` requires "single or multiple sessions per day" and `05` requires "unique attendance
record per student/session". But `attendance_sessions` is described as
(school, year, section, date, session_type) — so two sessions of the *same* type on one day
have no discriminator, and a uniqueness constraint would forbid the very thing `FR-007` asks for.

**Recommended:** add `session_ordinal smallint` and an optional
`class_subject_id` (null = section-level daily register), with
`UNIQUE(section_id, date, session_ordinal)`. School config declares how many sessions/day and
whether they are subject-linked.

### D-11 (B) — "Unmarked is not absent" needs a storage decision, not just a rule

`FR-007` and `08 §2` both forbid treating unmarked as absent, but never say whether an
unmarked pupil gets a row with an explicit state or no row at all. This determines whether
completeness reporting is a column filter or a roster diff.

**Recommended:** **no row** for an unmarked pupil. Absence of a record means "not marked",
which is unforgeable and cannot be mistaken for a status. A session carries its own
`status ∈ {open, submitted, approved}` and a `submitted_at`; completeness is
`count(records) vs count(active enrolments)`. `attendance_statuses` is a per-school
configurable lookup (`present`, `absent`, `late`, `approved_leave`, …) with an
`is_present_equivalent` flag so reports never hardcode a status list.

### D-12 (B) — `enrollments` has no effective dates, so historical attendance cannot be validated

`05` requires an attendance session to "match the student's enrolment/section for that date",
but `enrollments` carries only a `status`. If a pupil moves from section A to B in October,
there is no way to know which section they belonged to in September — so validating or
reporting September attendance is impossible without rewriting history.

**Recommended:** add `effective_from date NOT NULL` and `effective_to date NULL` to
`enrollments`, with an exclusion constraint preventing overlapping active enrolments per
(student, academic_year). Roster resolution is always "enrolments covering this date".

### D-13 (M) — `students.status` vs `enrollments.status` precedence is undefined

Both exist; nothing says which wins when they disagree (e.g. student `active`, enrolment
`withdrawn`).

**Recommended:** `students.status` is lifecycle at school level and gates login;
`enrollments.status` gates academic participation. A pupil is markable only when **both**
are active and the date falls inside the enrolment window. Encode this in one
`resolveRoster()` function, not in call sites.

---

## D. Exams, homework, calendar

### D-14 (I) — `examinations.exam_type` is not linked to the configured assessment scheme

`FR-011` requires published results to "preserve the scheme/version used", and `05` has
`assessment_schemes` → `assessment_types`. But `examinations.exam_type` is a free-text field
with no FK to `assessment_types`, so the grading configuration is structurally disconnected
from the exam that used it.

**Recommended:** `examinations.assessment_type_id` FK, and on publication snapshot the
resolved scheme into `result_publications.scheme_snapshot jsonb`. Recomputation must read the
snapshot, never the live config.

### D-15 (I) — `assignments` targeting is contradictory

`assignments` references a single `class_subject` (already section-scoped), yet
`assignment_targets` exists to target multiple sections. Both cannot be the source of truth.

**Recommended:** `assignments` holds (school, subject, created_by) and
`assignment_targets(assignment_id, section_id)` is the sole targeting mechanism. Authorization
checks that the teacher holds an assignment for **every** targeted section-subject.

### D-16 (I) — District-vs-school calendar precedence is required but never defined

`FR-008` says "Define precedence when district-wide and school calendars overlap" — the
blueprint states the requirement and then never answers it.

**Recommended (needs your confirmation, see Q3):** district holidays are binding and a school
may add but not remove them; a school closure may extend a district working day into a
holiday but not the reverse. Resolution is a single ordered query, not per-screen logic.

### D-17 (M) — `timetable_periods` hangs off a per-section version, duplicating school bell times

Period start/end times are school-wide in practice, but `timetable_versions` is per section,
so every section redefines them and they can silently drift apart.

**Recommended:** `period_templates` at school level; `timetable_versions` references a template
and only maps period → class_subject → teacher → room.

---

## E. API and platform

### D-18 (B) — School registration cannot require authentication

`06` states "All endpoints require authentication unless explicitly marked public", and marks
nothing public — but `POST /schools` is how a school that has no users yet requests an account.
As written the onboarding flow is unreachable.

**Recommended:** `POST /schools/registration-requests` is **public and strictly rate-limited**,
and writes to a quarantined `school_registration_requests` table. It does **not** create a
`schools` row; approval does, inside a transaction that also creates the first admin
membership. This also keeps unverified input out of the tenant tables.

### D-19 (I) — `403` vs `404` policy must be fixed per resource class, not left to taste

`06 §8` offers both ("404 may be used to avoid resource enumeration") without saying when.
Inconsistency here is itself an enumeration oracle.

**Recommended:** **404** for any object addressed by an ID the caller cannot see
(cross-tenant, cross-child, unpublished). **403** only when the caller can legitimately see
the object but lacks the *action* permission. Centralized so it cannot drift.

### D-20 (M) — Localization boundary between API and clients is unspecified

`FR-015` requires all user-facing text to come from translation resources, but API errors are
user-facing and school-authored content (notices, homework) is free text in whatever language
the author typed.

**Recommended:** API returns stable machine-readable `code` + non-localized `detail` for
logs; clients own all translation. School-authored content gets a `content_language` column
and is never machine-translated.

---

## F. Things the blueprint states that I cannot verify or commit to

- **Uptime 99.5% / p95 < 2s** (`01 §2`) — unverifiable until hosting is chosen; recorded as a
  target, not a guarantee.
- **DPDP Act 2023 / Rules 2025 compliance** (`07 §3`) — I will implement the *mechanisms*
  (consent records, guardian verification, retention config, audit, data-subject request
  workflow). Whether they satisfy the Act, and whether the educational-institution exemption
  applies, needs a qualified Indian privacy lawyer. I will not mark any compliance checkbox.
- **Aadhaar / biometrics / GPS** — excluded by default per `07 §4`; no columns will exist for
  them.
- **Repository name mismatch** — the repo is `Smart-ATtedence-system` ("attendance", misspelled)
  but the product is a full school-management platform. Worth renaming the GitHub repo; the
  misspelling will otherwise appear in every clone URL, package name and CI badge.

---

## Questions that need your decision

These are the ones where I should not just pick for you.

- **Q1 — Attendance granularity at launch.** Is the pilot taking attendance **once per day per
  section** (my assumption, simplest and matches most government primary schools), or
  **per period/subject**? This changes the register UI, the authorization path (D-01) and the
  reporting model. The schema I propose supports both; the question is what to build first.
- **Q2 — Who approves school registrations?** Platform staff only, or can a district officer
  approve schools in their own district? `FR-001` says "platform or delegated authorized
  staff" without deciding. Affects the approval-authority check.
- **Q3 — Calendar precedence (D-16).** Confirm: district holiday is binding, school may add
  but not remove. Correct?
- **Q4 — Parent OTP delivery for the pilot.** A real SMS gateway (MSG91/Gupshup/etc.) is a paid
  service and `00 §8` says to ask before introducing one. Until you choose one, I will build
  against an `SmsProvider` interface with a **logging dev implementation** — OTPs appear in the
  server log, never in the API response. Confirm that is acceptable for now.

---

## Answers received (2026-09-29)

### Q1 → **Per period / per subject.**

Consequences:

- **D-01 is no longer a blocker.** With a subject-linked register,
  `teacher_assignments` → `class_subjects` authorizes attendance directly; the
  class-subject/section mismatch disappears.
- `attendance_sessions.class_subject_id` is **NOT NULL**. There is no section-level
  daily register at launch.
- Uniqueness becomes `UNIQUE(section_id, date, class_subject_id, session_ordinal)`.
  `session_ordinal` is retained because a subject can legitimately occupy two periods
  in one day (D-10).
- `section_teachers` / class-teacher (proposed under D-01) is **deferred**. Nothing in
  the launch scope needs it: subject teachers mark, and the principal approves
  corrections. Building it now would be speculative scaffolding.
- Accepted cost: a pupil generates one attendance record per period, so record volume
  scales with the timetable. Reporting must aggregate periods into a day before showing a
  parent an attendance percentage, and "was my child in school today" is now a derived
  question rather than a stored fact. Percentages will therefore be defined over
  **periods**, and the API will label them as such so clients cannot present a
  period-based figure as a day-based one.

### Q2 → **Platform staff only approve school registrations.**

Consequences:

- Approval authority is a single platform permission; no delegation path in Slice 1.
- **D-03 (area-level officer scope) is deferred** out of Slice 1. District/area membership
  is still modelled for later reporting, but no approval logic depends on it.
- D-04 (support access grants) becomes more pressing, not less: platform staff now
  necessarily touch the onboarding path, so the boundary between "may approve a school"
  and "may read that school's academic data" must be enforced rather than assumed.
  Approval permission grants **no** academic read access.

### Q3 → Proceeding on the recommended default
District holidays bind schools; a school may add holidays but not remove district ones.
Deferred to the calendar slice; revisit before building it.

### Q4 → Proceeding on the recommended default
`SmsProvider` interface with a dev implementation that logs the OTP server-side. No paid SMS
gateway will be introduced without asking.

**Amended 2026-09-30 (owner instruction for Slice 3): OTP values are never logged.** The dev
adapter keeps messages in process memory only, readable solely by code holding the instance
(the test harness); it logs a masked recipient and never the body, and refuses to start when
`NODE_ENV=production`. `SMS_PROVIDER=none` disables OTP login with an honest `503`. Consequence:
until a provider (or a vendor sandbox) is chosen, the parent login can be exercised end to end
only through the automated tests, not by hand against a running dev server.

### D-08 → resolved in Slice 3
`POST /auth/login` keeps its `method` discriminator for single-step credentials. Phone login is
two-step (request, then verify), so it lives at `POST /auth/otp/request` and
`POST /auth/otp/verify` as `06 §1` lists, and `/auth/otp/verify` returns the same token pair as
`/auth/login`. No `phone_otp` variant was added to the login union.
