# Architecture Proposal

Status: **awaiting sign-off**. Depends on `00_ANALYSIS_AND_OPEN_DECISIONS.md`.

## 1. Stack — confirmed and deviations

Confirmed from `04_ARCHITECTURE.md`: React Native + Expo (mobile), Next.js (web),
NestJS REST API, PostgreSQL, Drizzle ORM + drizzle-kit migrations, pnpm workspace,
TypeScript strict.

Deviations, and why:

| Blueprint | Actual | Reason |
|---|---|---|
| Docker / docker-compose | **Podman** | Verified: `podman 5.8.1` present, `docker` absent on this machine. Compose file stays OCI-standard so Docker works unchanged elsewhere. |
| Redis + BullMQ from the start | **Deferred to Phase 3** | Slices 1–2 have no async work. Notifications/exports are the first real need. Introducing a queue now would be untested scaffolding, which `00 §8` forbids. |
| S3-compatible object storage | **Deferred to Phase 3** | Same reason — no file upload before homework/materials. `StorageProvider` interface only. |
| Managed identity provider | **Custom, reviewed** | A managed IdP cannot express school-scoped student IDs or guardian relationships. Auth is custom but confined to one module with argon2id and no hand-rolled crypto. |

Toolchain verified on this machine: Node `v22.22.2`, pnpm `11.13.0`, PostgreSQL `16.15`
reachable on `127.0.0.1:55432` in a Podman container. `gen_random_uuid()` is built in — no
`pgcrypto` extension needed.

## 2. Repository structure

Follows `04 §5` with the additions justified below.

```text
Smart-ATtedence-system/
├── apps/
│   ├── api/                  # NestJS REST API (the only writer to the database)
│   ├── web/                  # Next.js — school admin + district portals
│   └── mobile/               # Expo — student, parent, teacher
├── packages/
│   ├── database/             # Drizzle schema, migrations, seed, test-db harness
│   ├── shared/               # Request/response schemas (zod), error codes, domain types
│   ├── permissions/          # Permission keys + policy definitions (no I/O, pure)
│   ├── i18n/                 # en / kn translation resources
│   └── config/               # tsconfig, eslint, prettier bases
├── docs/
│   ├── blueprint/            # The supplied source-of-truth documents, unmodified
│   └── decisions/            # This analysis + ADRs
├── infrastructure/
│   └── compose.yaml          # Postgres (and later Redis/MinIO) for local + CI
├── tests/
│   ├── authorization/        # Negative tenant/relationship tests — first-class, not an afterthought
│   └── integration/          # Vertical-slice tests against a real database
├── pnpm-workspace.yaml
└── .env.example
```

`packages/permissions` is pure and dependency-free on purpose: policy decisions must be unit
testable without a database, and the same definitions must be importable by the web portal to
hide controls the caller cannot use. Hiding UI is cosmetic — the API still re-checks everything.

## 3. Authentication

- **Access token**: short-lived JWT (10 min), carrying **only** `sub` (user id) and `sid`
  (session id). Nothing else.
- **Refresh token**: opaque 256-bit random, stored only as SHA-256 hash, single-use, rotated
  on every refresh with `parent_session_id` lineage. Reuse of a rotated token revokes the
  entire lineage and writes an audit entry.
- **Passwords/PINs**: argon2id. Student PINs are additionally rate-limited per (school, student)
  because a 4–6 digit PIN has low entropy by nature.
- **Parent**: phone + OTP. OTP is hashed at rest, single-use, short expiry, attempt-capped, and
  **never** returned in an API response.
- **Rate limiting**: per-IP and per-identifier on login, OTP request, OTP verify and recovery.

### The important consequence: the JWT carries no authorization data

No roles, no school ids, no child ids in the token. Every request re-resolves memberships,
teacher assignments and guardian links from the database.

This is a deliberate cost (one extra query per request, indexed and cheap) paid to satisfy two
explicit requirements that a claims-stuffed token cannot meet:

- `08 §4`: *"Revocation immediately blocks future requests."*
- `07 §2`: *"Revoked guardian retains access through a stale session/cache"* — listed as a
  threat to test.

With scopes baked into a 10-minute token, a revoked guardian keeps access for up to 10 minutes.
That is a real data-leak window involving a child's records, so the token stays thin.

## 4. Authorization

Three layers, all mandatory:

1. **Schema validation** at the HTTP boundary (zod, via a global pipe). Rejects malformed input
   before any policy runs.
2. **Policy layer** — one `authorize(principal, action, resource)` call per protected operation,
   inside the service, not only in a guard. Resolution order:
   `permission default for (scope_type, role)` → `membership grant override` (D-02) →
   `relationship check` (school membership · teacher/section assignment · guardian link ·
   admin scope containment) → `record state check` (published? active enrolment? open session?).
3. **Database constraints** — composite foreign keys make cross-school rows unrepresentable,
   not merely rejected. The pattern throughout:

   ```sql
   -- students carries a redundant school_id so children can be tied to it compositely
   CREATE TABLE students (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id uuid NOT NULL REFERENCES schools(id),
     student_number text NOT NULL,
     UNIQUE (school_id, student_number),
     UNIQUE (id, school_id)              -- target for composite FKs below
   );

   CREATE TABLE enrollments (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id uuid NOT NULL,
     student_id uuid NOT NULL,
     section_id uuid NOT NULL,
     FOREIGN KEY (student_id, school_id) REFERENCES students (id, school_id),
     FOREIGN KEY (section_id, school_id) REFERENCES sections (id, school_id)
   );
   ```

   A row enrolling a School-A pupil into a School-B section cannot be inserted even by a bug in
   the service layer, a migration, or a psql session. Row-level security is planned as a fourth
   layer once the query patterns settle (`02 §4.7` calls it defense in depth, not the primary
   control).

**Never** authorize on role name alone (`02 §2`). The policy function takes a resource, always.

## 5. Error and status policy

Per D-19: **404** when the caller cannot see the object at all (cross-tenant, cross-child,
unpublished); **403** only when the object is visible but the action is not permitted. Emitted
from one exception filter so it cannot drift between modules. Responses carry a stable `code`,
a `requestId`, and no stack traces, storage keys or unrelated student data.

## 6. Testing strategy

- **Real PostgreSQL, never a mock or SQLite.** The isolation guarantees above *are* composite
  foreign keys and constraints; a mocked repository would test nothing that matters.
- Each test file gets a freshly migrated, uniquely named database, dropped on teardown, so
  tests are order-independent and parallel-safe.
- **Negative authorization tests are a deliverable of every slice**, not a later hardening pass.
  Every scenario in `07 §2` becomes a named test. A slice is not done until the cross-tenant and
  cross-child tests fail closed.
- Seeds build a deliberately adversarial fixture: two schools in two districts, overlapping
  staff, a guardian with two children in different schools, and a revoked guardian link.

## 7. What Slice 1 will and will not do

Will: school registration request → approval → academic year → grades/sections/subjects →
student enrolment → teacher and class-teacher assignment → guardian linking with verification →
attendance session → transactional submission → correction with audit → student self-read →
parent read of linked child only.

Will not (deferred, and deliberately absent rather than stubbed): timetables, homework, files,
exams, notifications, imports/exports, district portal, report cards, queue, object storage.

## 8. Slice 1 as built (2026-09-29)

Tenancy and identity are implemented. What follows records where the build differs from, or
adds to, §1–§7 and the backlog, and why. API contract: [docs/api/README.md](../api/README.md).

### Schema — `packages/database/migrations/0001_tenancy_identity.sql`

Tables: `users`, `auth_identities`, `schools`, `school_registration_requests`,
`platform_memberships`, `school_memberships`, `user_sessions`, `refresh_tokens`,
`account_activation_tokens`, `audit_logs`.

Invariants enforced by the database, not only the service layer:

- `audit_logs` is append-only (a trigger rejects UPDATE/DELETE).
- `auth_identities.secret_hash` must be an argon2id string; a plaintext secret cannot be stored.
- Refresh and activation token hashes must be exactly 32 bytes (SHA-256).
- A registration request cannot be `approved` without a reviewer and a school, nor
  `rejected` without a reviewer and a note (`srr_decision_consistent`).
- School codes are unique and restricted to an unambiguous 31-character alphabet.
- Emails are stored normalized; phones as `+91…`.
- `refresh_tokens.parent_token_id` is unique, so a token can rotate into at most one successor
  even under a race.

**Deferred from the backlog's Slice 1 table list, deliberately:**

| Table(s) | Why not now |
|---|---|
| `districts`, `administrative_areas`, `admin_scope_memberships` | Q2 removed district approval, so nothing in Slice 1 reads them. The submitted district is kept as text on the request and the school; a later migration adds `districts` and backfills `schools.district_id`. |
| `permissions`, `role_permissions` | Role defaults live in `packages/permissions` (pure, unit-tested, importable by the web portal). A database copy with no writer would only be a second source of truth to drift. |
| `membership_permission_grants` (D-02 overlay) | No Slice 1 endpoint writes a grant. The policy function's shape (role default → overlay) is unchanged, and the table is purely additive. |

### Sessions — one session row, many refresh-token rows

D-09 proposed putting the token hash and lineage on `user_sessions`. The build splits it:
`user_sessions` is one login (its id is the JWT `sid`, re-read on every request), and
`refresh_tokens` is that login's rotation chain. Revocation is one row update, and the lineage
never has to be walked to find the session.

**Replay policy: no grace window.** A refresh token that was already used revokes the whole
session. A client that loses a refresh response and retries is logged out. Accepted, because a
grace window is precisely the interval an attacker racing a stolen token would exploit.
Concurrent presentations of one token are serialized by row locks; at most one can succeed and
the session ends revoked.

### Authorization plumbing

- `AuthGuard` is a global `APP_GUARD` — **default deny**. `@Public()` opts out, and a test
  pins the exact public route list.
- `AccessService.forSchool(principal, schoolId, permission)` returns a branded `SchoolScope`
  read from the caller's membership row. School services accept only a `SchoolScope`, so a
  query cannot be scoped by an unvalidated URL value.
- Non-member → 404; member without permission → 403 (D-19). Platform roles are never
  consulted on school routes.
- Platform routes check the permission **before** loading the target, so non-platform callers
  get the same 403 whether or not the target exists.

### Onboarding and activation

- Approval creates the school as `active`. The `pending` status stays in the CHECK list for a
  future "configured but not yet live" onboarding step (`08 §1` step 8), which Slice 1 does not
  implement.
- A new school admin (and any invited staff) receives a single-use activation token through the
  `AccountNotifier` interface. Tokens never appear in an API response. No email provider has
  been chosen (a paid service — needs your approval), so the only implementation logs the token
  and **refuses to start when `NODE_ENV=production`**. A real provider is therefore a
  prerequisite for any production deployment.
- The first platform admin is created by the `platform-admin:create` CLI. No HTTP route can
  create or grant a platform role.

### Rate limiting

An in-process fixed-window limiter (`apps/api/src/common/rate-limiter.ts`). **Limitation:**
counters are per instance and reset on restart, so N instances allow N× the rate. It becomes a
shared store when Redis arrives (§1). Behind a proxy, `TRUST_PROXY` must be set to the real hop
count, or every client shares the proxy's address.

### Libraries added

- `@node-rs/argon2`: argon2id with prebuilt N-API binaries, so no install script had to be allowed.
- `jose@5`: JWT signing and verification. Version 6 is ESM-only and cannot be loaded by this
  CommonJS build or by Jest.
- `drizzle-orm` as a direct API dependency; it resolves to the same copy as the database package.

## 9. Slice 2 as built (2026-09-30)

Academic structure, students, enrolments and teacher assignments. API contract:
[docs/api/README.md](../api/README.md) § Slice 2. Migration:
`packages/database/migrations/0002_academic_structure.sql` (0001 untouched; checksum verified
against the applied ledger before starting).

### Isolation at the database level

Every school-owned table exposes `UNIQUE (id, school_id[, academic_year_id])`, and children
reference it with composite foreign keys:

```text
sections        → academic_years (id, school_id), grades (id, school_id)
class_subjects  → sections (id, school_id, academic_year_id), subjects (id, school_id)
enrollments     → students (id, school_id), sections (id, school_id, academic_year_id)
teacher_assignments → class_subjects (id, school_id, academic_year_id),
                      school_memberships (id, school_id)   ← key created in 0001 for this
```

So a cross-school link, or a link between rows of different academic years, cannot be inserted
by any code path, including raw SQL. `academic-constraints.test.ts` proves each one with plain
SQL, with no application code involved.

### Temporal rules

- `academic_years`: `EXCLUDE USING gist (school_id =, daterange(start, end, '[]') &&)`.
  No two years of a school overlap, so "which year is this date in" has one answer.
  At most one `active` year per school (partial unique index). Requires `btree_gist`, a trusted
  extension created by the migration.
- `enrollments`: half-open `[effective_from, effective_to)`.
  `EXCLUDE (student_id =, academic_year_id =, daterange &&) WHERE voided_at IS NULL`, plus a
  partial unique index for "one current row per student per year". A trigger keeps the dates
  inside the year.
- **History is immutable.** A trigger rejects `DELETE` and any change to a placement. The only
  permitted updates are ending an open row once and voiding a live row once.
  Corrections are voids (row kept, reason on the row); transfers and promotions end one row and
  open a linked successor (`previous_enrollment_id`). Audit rows carry ids and dates only.

### Year lifecycle

`planned → active → closed → archived`, one way. Structural and enrolment writes take a
`FOR SHARE` lock on the year and require `planned|active`; closing takes `FOR UPDATE`, so a
close cannot interleave with a write. A closed year cannot be reopened through the API. If that
is ever needed, it should be a separately audited, privileged operation, not a status toggle.

### Authorization shape

New permissions are listed in the API reference. The important one is
`school.students.read_assigned`: teachers hold it, but it only takes effect through an active
teacher assignment to a class-subject of the student's current section (`AcademicAccess`).

Status codes:
- A student outside the teacher's sections → 404.
- The roster of an unassigned section of their own school → 403, since the section itself is
  visible through `academic.read` (D-19).
- Teachers never receive `dateOfBirth`.

### Decisions taken in this slice (open to revision)

| Topic | Decision | Why |
|---|---|---|
| Grade range | CHECK 1–7 | Launch scope; widening is a one-line migration |
| Grades per year? | Per school, not per year | "Class 5" is stable; sections carry the year |
| Class-subject scope | Per section (grade form expands to sections) | Q1 attendance is per subject **per section** |
| Student number | School may supply; otherwise per-school counter, zero-padded | Blueprint: school-issued, unique within school |
| Personal data | Name + optional DOB only | 07 §4 minimization; gender, address, guardians deferred |
| `students.user_id` (D-05) | Not added yet | Arrives with student login; additive |
| Roster vs current status | Roster ignores current student status | History: a leaver belongs on rosters before leaving (D-13) |
| Teaching roles | `teacher`, `school_admin` | Head teachers in small schools teach |
| Promotion direction | Target grade ≥ source grade | Same grade = repeating; demotion is not a promotion |

## 10. Slice 3 as built (2026-09-30)

Guardian linking and parent phone identity. API: [docs/api/README.md](../api/README.md) § Slice 3.
Migration `0003_guardians.sql`. Before starting, I confirmed that `0001` and `0002` still match
their applied checksums; `0003` widens `auth_identities` with `ALTER`s rather than editing `0001`.

### Identity model

```text
users ─ auth_identities(phone_otp, subject = +91…)     parent account; one per phone (D-06)
guardians(school_id, full_name, phone)                 school-owned contact record, UNIQUE(school, phone)
student_guardians(school_id, student_id, guardian_id,  the link; relationship_type here (D-07)
                  relationship_type, status, who/when)
guardian_link_claims                                    parent requests, stored whether or not they match
otp_challenges                                          HMAC'd one-time codes
```

- **Guardians are per school, not global.** A parent with children in two schools has one record
  in each, joined only by the OTP-verified phone of their login. As a result no school ever reads a
  name or number that another school entered. Siblings in one school share one record.
- **The phone is the join, and it is re-evaluated per request**: session user → phone_otp
  identity → `guardians.phone` → verified link → student in an active school. Nothing is cached in
  the token. That is why a guardian's phone cannot change while it has live links: the change would
  silently re-route the child to whoever owns the new number.
- **Composite FKs** `(student_id, school_id)` and `(guardian_id, school_id)` make a cross-school
  link unrepresentable.
- **History**: a trigger forbids deletes, rewrites of link identity, and transitions other than
  `pending→verified|rejected`, `verified→revoked`. CHECKs require who and when for each state, and a
  reason for rejected/revoked.

### OTP design

| Property | Mechanism |
|---|---|
| No plaintext at rest | `code_hmac = HMAC-SHA256(key, challengeId ‖ code)`; key = `OTP_HASH_SECRET` or HKDF(JWT secret, "otp-code-hmac-v1") |
| No plaintext in logs | Code exists only in memory until handed to the provider; dev outbox logs a masked recipient; a test asserts stdout/stderr never contain it |
| Expiry | `expires_at`, default 5 min |
| Attempt limit | `attempts`/`max_attempts` (5), committed even on failure; exhausted → invalidated |
| Replay | `consumed_at` on first success; the partial unique index allows one open challenge per phone |
| Concurrency | `SELECT … FOR UPDATE` on the challenge: simultaneous correct codes → one session |
| Brute force | ≤ 10 wrong codes / phone / hour, 60 / IP / 15 min, one code per minute per phone |
| Enumeration | Every valid mobile gets a challenge; one `202` body; one `400` for every verify failure |
| SMS pumping | Global 1,000 / hour ceiling, per-IP and per-phone caps, Indian mobiles only |
| Honesty | `delivery_status` ∈ pending / sent / dev_outbox / failed; provider failure → `503` and the code is withdrawn |

**Provider decision: none made.** `SmsProvider` is a two-member interface. `SMS_PROVIDER` currently
accepts `dev_outbox` (memory only, refuses production) and `none` (`503`). Choosing a vendor
(MSG91, Gupshup, Kaleyra, AWS SNS, …) is a cost, DLT-registration and data-processing decision for
the owner. Indian commercial SMS also requires TRAI DLT sender and template registration.

**Open request, deliberately.** OTP is offered to any valid Indian mobile, not only numbers some
school has entered, because `08 §4` puts "parent account is verified" *before* the school confirms
the relationship, and because a restricted list would reintroduce an enumeration channel through
timing. The cost is SMS spend, bounded by the limits above.

### Link workflow and policies

- Staff-initiated links and parent claims both start `pending`; only `school.guardians.manage`
  (school admins) can verify, reject or revoke. Parents have no school role, so they cannot move a
  link at all.
- **Self-approval**: a reviewer whose user phone or phone login equals the guardian's phone gets
  `403`. **Residual risk:** one person holding two separate accounts (an email staff account and a
  phone parent account with different numbers) is not detected. A maker–checker rule for
  `guardian_claim` links is a follow-up.
- **Conflicting claims** are never auto-resolved. Several pending links on one student are all held.
  The review payload carries `otherLiveLinksForStudent`, and the reviewer decides each one.
- **Claims and enumeration**: a claim row is stored even when nothing matches, and the parent sees
  `pending` in both cases. Two residual signals are accepted: `declined` appears only after a human
  rejected a *matched* claim, and the matched path does a few more writes, a small timing
  difference behind a 10-per-day limit.
- **Students who leave**: links are not auto-revoked on withdrawal or transfer. The parent keeps
  seeing that school's record of their child (status shown, no current placement) until the school
  revokes, consistent with FR-004. No new links are created or verified for non-active students.
  Transfers between schools never carry links; the new school verifies its own.
- **Recycled numbers**: phone-as-identity means a reassigned mobile number inherits the account.
  Schools must revoke when told of a number change. A periodic re-verification policy is a
  follow-up.

### Deferred

`consent_records` (backlog Slice 3) is not built. Recording "consent" before the purposes and
lawful basis are settled by the legal review in `07 §3` would create rows that look like compliance
without being it.

## 11. Slice 4 as built (2026-09-30)

Per-period attendance. API: [docs/api/README.md](../api/README.md) § Slice 4. Migration
`0004_attendance.sql`. Before starting I checked that the working tree held only the uncommitted
Slices 1–3 and that `0001`–`0003` matched their applied checksums. `0004` adds two unique keys to
existing tables with `ALTER` (composite-FK targets) and a new trigger on `enrollments`; no
earlier migration was edited.

### Schema

```text
attendance_sessions(school, year, section, class_subject, session_date, period, status, submit key+hash)
   FK (class_subject_id, school_id, academic_year_id, section_id) → class_subjects   ← new key via ALTER
   UNIQUE (section_id, session_date, period)
attendance_records(session, section, student, enrollment, status, revision)
   FK (session_id, school_id, section_id)                    → attendance_sessions
   FK (enrollment_id, school_id, section_id, student_id)     → enrollments          ← new key via ALTER
   UNIQUE (session_id, student_id)
attendance_corrections(record, revision, old_status, new_status, reason, actor, time)   append-only
```

**Slot uniqueness is stricter than Q1 recorded.** Q1 recorded `UNIQUE(section, date,
class_subject, ordinal)`. The build uses `UNIQUE(section, date, period)`: one register per section
per period, so two subjects cannot both claim the same period. **Limitation:** a section split
into electives during one period cannot be registered separately. Relaxing this later would be a
migration that widens the key.

### Integrity rules enforced by PostgreSQL

| Rule | Mechanism |
|---|---|
| Session's section/year/school = its class-subject's | composite FK |
| Session date inside the academic year | trigger (bounds are on another row) |
| Record's pupil is enrolled in the session's section, school | composite FK to `enrollments` |
| That enrolment is live and covers the session date | trigger on insert |
| One record per pupil per session | unique key |
| A record's status changes only with a matching correction row (revision + 1, old → new) | trigger |
| No deletes of sessions, records or corrections; corrections never updated | triggers |
| Voiding an enrolment with attendance; ending it on/before a date with attendance | trigger on `enrollments` |

The last rule closes the D-12 hole Slice 2 left open. Voids, transfers, withdrawals and
transfer-outs all pass through it whatever the code path. The API maps it to `409`: previously
`void` and `changeStatus` had no constraint translation and would have returned `500`.

### Policies (defaults; configurable where noted)

- **Year**: only the `active` year accepts attendance, consistent with Slice 2's closed-is-read-only
  rule. Closed years remain readable.
- **Dates**: no future dates, with "today" computed by PostgreSQL in `ATTENDANCE_TIMEZONE`
  (default `Asia/Kolkata`). Teachers are limited to `ATTENDANCE_TEACHER_BACKDATE_DAYS` (default
  7); admins may use any date in the active year. Calendar and holiday checks are deferred.
- **Statuses**: `present`, `absent`, `late`, `approved_leave`, from FR-007's list.
  **Per-school configurable statuses (backlog) are deferred.** A CHECK list is simpler to report
  on correctly, and nothing yet needs a custom status. `present` and `late` are present-equivalent
  via one shared constant.
- **Submission**: whole-roster only. It is atomic, row-locked, and idempotent through the
  `Idempotency-Key` header, which is stored with a SHA-256 of the canonicalised payload on the
  session. No partial registers are accepted, because a partial one would be indistinguishable from
  an unfinished one.
- **Finality and corrections**: a submitted register is final. Changes are corrections by
  **school admins only**, which follows Q1's "the principal approves corrections"; teacher
  correction *requests* are a follow-up. A reason is required, and each correction is appended with
  old value, new value, actor and time. The reason stays on the correction row; `audit_logs`
  records ids and statuses only, following the Slice 2 convention of keeping free text out of the
  audit log.
- **Unmarked (D-11)**: no row. A pupil enrolled later with a backdated start shows as `null` on an
  already-submitted register and counts nowhere until an admin marks them by correction
  (`old_status NULL`).
- **Retention**: nothing is deleted. Sessions, records and corrections are permanent history,
  matching enrolments and guardian links.

### Access

- Teachers need an **active teacher assignment** to the register's class-subject for every read and
  write, re-checked per request. Ending the assignment removes access immediately. A mutation test
  (disabling this check) makes exactly the two authorization tests fail.
- Parents reach attendance only through `ParentService.child()`, i.e. the Slice 3 chain (phone
  identity → guardian record → verified link → active school). The data comes from the school where
  the link is verified, and correction reasons are not exposed.
- **Student self-view: not built.** `students` has no link to a login (D-05's `user_id` is
  deferred), so any endpoint would need an invented identity mapping. The student-login slice
  should add it.

### Shared roster resolver

`academic/roster.ts` is now the one definition of "who is in this section on this date" (D-13).
The Slice 2 section-roster endpoint was refactored onto it, and the 58 academic tests still pass.
Attendance uses the same function for opening, displaying, submitting and correcting registers.
