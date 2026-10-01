# API Reference

Base prefix: `/api/v1` (except `/health`). JSON in, JSON out.

**Status:** hand-maintained for Slice 1. OpenAPI generation (`06 §8`) is a backlog item; until
then this file is the contract. `apps/api/src/auth/public-routes.test.ts` fails if the set of
public routes below changes without that test being updated.

## Conventions

### Authentication

Every route requires `Authorization: Bearer <accessToken>` **unless marked Public**. The access
token is a 10-minute HS256 JWT carrying only `sub` (user id) and `sid` (session id). It grants
nothing by itself: each request re-reads the session and the caller's memberships, so logout,
membership revocation and account disablement take effect on the very next request.

### Errors

Every error has one shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "school not found or not visible to caller", "requestId": "…" } }
```

`fields: [{ path, message }]` is added for `VALIDATION_FAILED`. Clients localize by `code`;
`message` is developer-facing English and is never shown to end users (D-20).

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Payload, query or path parameter failed its schema |
| 400 | `INVALID_OR_EXPIRED_TOKEN` | Activation token unknown, used or expired (deliberately not distinguished) |
| 401 | `UNAUTHENTICATED` | No/invalid credentials or token |
| 401 | `ACCESS_TOKEN_EXPIRED` | Refresh, then retry |
| 401 | `SESSION_REVOKED` | Session logged out, revoked for refresh-token reuse, or the account was disabled — log in again |
| 401 | `SESSION_EXPIRED` | Session passed its absolute lifetime — log in again |
| 403 | `PERMISSION_DENIED` | Caller can see the resource but may not perform this action |
| 404 | `NOT_FOUND` | Does not exist **or** caller may not see it — indistinguishable by design (D-19) |
| 409 | `STATE_CONFLICT` / `DUPLICATE_RESOURCE` | Already decided / already exists |
| 429 | `RATE_LIMITED` | Includes a `Retry-After` header (seconds) |

### Tenancy

A `:schoolId` path segment **selects** which of the caller's memberships to act under; it is
never proof of authorization. No active membership in an active school → `404`, whether or
not the school exists. Unknown body fields (including `schoolId`) are stripped by validation.

Platform roles grant **no** school access. A platform admin gets `404` on every `/schools/:id`
route (Q2).

---

## Health

### `GET /health` — Public
`200 {"status":"ok"|"degraded","checks":{"database":"up"|"down"}}`

---

## School registration

### `POST /schools/registration-requests` — Public, rate-limited
Submits a request for platform review. Creates **no** school, user or credential (D-18).

```jsonc
{
  "schoolName": "Government Higher Primary School, Hebbal",
  "sector": "government",            // "government" | "private"
  "udiseCode": "29260100101",        // optional, 11 digits
  "districtName": "Mysuru",
  "addressLine": "1st Main Road",
  "pincode": "570017",
  "contactName": "Lakshmi Devi",
  "contactEmail": "head@example.in", // trimmed + lower-cased
  "contactPhone": "98450 12345"      // Indian mobile, stored as +919845012345
}
```

`202 {"status":"pending_review"}` — identical for every accepted submission, duplicates
included, and no id is returned.
Limits (per API instance): 5/hour per client IP, 3/day per contact email.

---

## Platform review

All require the `platform.school_registrations.review` permission (role `platform_admin`).
Without it: `403`, returned **before** the target is looked up, so existence is not revealed.

### `GET /platform/school-registration-requests?status=pending&limit=50&offset=0`
`status` ∈ `pending` (default) | `approved` | `rejected`; `limit` 1–100; ordered by submission
time, then id. → `200 {"items":[RegistrationRequest…],"limit":50,"offset":0}`

### `GET /platform/school-registration-requests/:id`
→ `200 RegistrationRequest` · `404` if unknown.

### `POST /platform/school-registration-requests/:id/approve`
Body `{"note"?: string}`. In one transaction: creates the school (status `active`) with a
random 8-character code from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, finds or creates the contact's
user, creates a `school_admin` membership, issues an activation token if the user has no
password, records the decision and audit rows.

→ `200 {"registrationRequestId","status":"approved","school":{"id","schoolCode","name","status"}}`
· `409 STATE_CONFLICT` if already decided · `409 DUPLICATE_RESOURCE` if the UDISE code
belongs to an existing school.

The activation token is sent to the contact through the account notifier. **It never appears
in this response.**

### `POST /platform/school-registration-requests/:id/reject`
Body `{"reason": string}` (required). → `200 {"registrationRequestId","status":"rejected"}` · `409`.

---

## Authentication

Tokens are returned in the JSON body (suits the mobile app). The web portal will use an
HttpOnly cookie with CSRF protection via separate routes.

`IssuedTokens`:
```json
{
  "tokenType": "Bearer",
  "accessToken": "<JWT>",
  "accessTokenExpiresIn": 600,
  "refreshToken": "<43-char opaque>",
  "refreshTokenExpiresAt": "2026-10-29T12:00:00.000Z"
}
```

### `POST /auth/login` — Public, rate-limited
Discriminated on `method` (D-08). Slice 1 implements only:
```json
{ "method": "staff_password", "email": "head@example.in", "password": "…" }
```
→ `200 IssuedTokens` · `401 UNAUTHENTICATED "Invalid credentials"` for **every** failure:
unknown email, wrong password, not yet activated, disabled. Timing is equalized with a dummy
argon2 verification.
Limits: 30 attempts / 15 min per IP; 10 **failures** / 15 min per email, after which even the
correct password gets `429` until the window passes (the same for unknown emails).

### `POST /auth/refresh` — Public, rate-limited
`{"refreshToken": "…"}` → `200 IssuedTokens` with a **new** refresh token. The session's absolute
expiry (`REFRESH_TOKEN_TTL_SECONDS`, default 30 days from login) is not extended.

Each refresh token works **once**. Presenting a token that was already rotated revokes the whole
session — the legitimate client's newer tokens stop working too — and returns
`401 SESSION_REVOKED`. There is no grace window, so a client must not retry a refresh in
parallel; on a lost response it must log in again.

### `POST /auth/logout`
Revokes the current session. `204`. Other sessions of the same user are unaffected.

### `POST /auth/staff/activate` — Public, rate-limited
`{"token": "<43-char opaque>", "password": "…"}` — password 12–128 characters, NFKC-normalized.
Sets the first password. `204` · `400 INVALID_OR_EXPIRED_TOKEN`. Single use; activation
tokens expire after `ACTIVATION_TOKEN_TTL_SECONDS` (default 72 h). A validation failure does not
consume the token.

---

## Current user

### `GET /me`
```json
{
  "user": { "id", "displayName", "email", "preferredLanguage": "en" },
  "platform": { "roles": ["platform_admin"], "permissions": ["platform.school_registrations.review"] }
}
```

### `GET /me/schools`
Active memberships: `{"items":[{"schoolId","schoolCode","name","schoolStatus","role","permissions":[…]}]}`.
A suspended school is listed with `permissions: []` so the client can explain why it is
unusable. Permissions are UI hints only; every route re-checks.

---

## School (school-scoped)

| Route | Permission | `school_admin` | `teacher` |
|---|---|---|---|
| `GET /schools/:schoolId` | `school.profile.read` | ✓ | ✓ |
| `GET /schools/:schoolId/staff` | `school.staff.read` | ✓ | 403 |
| `POST /schools/:schoolId/staff` | `school.staff.manage` | ✓ | 403 |

### `GET /schools/:schoolId`
→ `200 {"id","schoolCode","name","sector","udiseCode","districtName","status"}`

### `GET /schools/:schoolId/staff`
→ `200 {"items":[{"membershipId","userId","displayName","email","role","status","joinedAt"}]}`

### `POST /schools/:schoolId/staff`
`{"email","displayName","role":"school_admin"|"teacher"}` → `201 {"membershipId","userId","role"}`.
Creates the account if needed and sends an activation token to it. The response has the same
shape whether or not the person already had an account elsewhere, and an existing person's
display name is never overwritten. `409 DUPLICATE_RESOURCE` if already a member of this school.

---

## Operator tooling (not HTTP)

The first platform admin can only be created from a shell; no HTTP route can grant a platform role.

```bash
read -rs PLATFORM_ADMIN_PASSWORD && export PLATFORM_ADMIN_PASSWORD
pnpm --filter @smart-school/api platform-admin:create --email ops@example.org --name "Ops Person"
```

The password is read from the environment, not argv (argv is visible via `ps`). Re-running
for an existing user grants the role but never replaces their password.

---

# Slice 2 — Academic structure, students, enrolments, teacher assignments

All routes are under `/schools/:schoolId/…` and follow the tenancy rules above: `:schoolId`
selects one of the caller's memberships; every other id in the path or body is re-resolved
inside that school, so an id from another school behaves exactly like one that does not exist
(`404`). Dates are `YYYY-MM-DD` calendar dates. List routes marked *paginated* take
`limit` (1–100, default 50) and `offset`, and return `{items, limit, offset}` in a stable order.

### Permissions

| Permission | `school_admin` | `teacher` |
|---|---|---|
| `school.academic.read` — years, grades, sections, subjects, class-subjects | ✓ | ✓ |
| `school.academic.manage` — create/change structure, year lifecycle | ✓ | — |
| `school.students.read` — every student and roster | ✓ | — |
| `school.students.read_assigned` — students/rosters **of sections they actively teach** | ✓ | ✓ |
| `school.students.manage` — students, enrolments, promotions, status | ✓ | — |
| `school.teacher_assignments.manage` | ✓ | — |
| `school.teacher_assignments.read_own` | ✓ | ✓ |

`read_assigned` is a relationship check, not a role check: a teacher sees a student only while
an **active** assignment links them to a class-subject of the student's **current** section.
Ending the assignment or moving the pupil removes access on the next request.

| Situation | Status |
|---|---|
| Not a member of an active school (incl. a school not yet approved, or suspended) | 404 |
| Id belongs to another school, or does not exist | 404 |
| Teacher asks for a student outside their sections | 404 |
| Teacher asks for the roster of an unassigned section of their own school | 403 |
| Teacher calls a write route | 403 |

## Academic years

| Route | Permission | Notes |
|---|---|---|
| `GET /academic-years?status=` | read | Archived years hidden unless `status=archived` |
| `POST /academic-years` | manage | `{name, startDate, endDate}` → `201` with `status: "planned"` |
| `GET /academic-years/:yearId` | read | |
| `PATCH /academic-years/:yearId` | manage | `{name?, startDate?, endDate?}`; **planned** years only; dates frozen once anyone is enrolled |
| `POST /academic-years/:yearId/open` | manage | planned → active |
| `POST /academic-years/:yearId/close` | manage | active → closed |
| `POST /academic-years/:yearId/archive` | manage | closed → archived |

Rules: `endDate > startDate`, span ≤ 550 days (400). Name unique per school (`409
DUPLICATE_RESOURCE`). Years of one school never overlap (`409 STATE_CONFLICT`). At most one
`active` year per school (`409`). Transitions go one way only; a closed year cannot be
reopened, and **closed/archived years reject every structural and enrolment write (`409`)**.

`AcademicYear`: `{id, name, startDate, endDate, status}`

## Grades (classes)

| Route | Permission | Body |
|---|---|---|
| `GET /grades` | read | |
| `POST /grades` | manage | `{gradeNumber: 1–7, displayName?}` — default `"Class N"`; unique per school |

Grades are per school, not per year.

## Sections

| Route | Permission | Body / query |
|---|---|---|
| `GET /academic-years/:yearId/sections?gradeId=` | read | |
| `POST /academic-years/:yearId/sections` | manage | `{gradeId, name}` |

Names are the school's own (`"A"`, `"Kaveri"`, …), up to 40 characters, unique per
(year, grade) ignoring case (`409`).
`Section`: `{id, academicYearId, gradeId, gradeNumber, name}`

## Subjects

| Route | Permission | Body |
|---|---|---|
| `GET /subjects` | read | |
| `POST /subjects` | manage | `{code, name, nameTranslations?: {en?, kn?}}` |
| `PATCH /subjects/:subjectId` | manage | `{name?, nameTranslations?, status?: "active"\|"retired"}` |

`code`: 2–16 of `A-Z 0-9 _`, upper-cased, unique per school, immutable. `name` is the school's
primary label in any language; `nameTranslations` holds optional per-UI-language labels — an
unsupported language key is a `400`, not silently dropped. A retired subject keeps its history
but cannot be newly assigned (`422`). `SUGGESTED_SUBJECTS` in `@smart-school/shared` lists
common Karnataka primary subjects for clients to offer; the server never seeds them.

## Class-subjects

| Route | Permission | Body |
|---|---|---|
| `GET /academic-years/:yearId/class-subjects?sectionId=` | read | |
| `POST /academic-years/:yearId/class-subjects` | manage | `{subjectId, sectionId}` **or** `{subjectId, gradeId}` |

The `gradeId` form creates the subject on every section of that grade in the year, all-or-nothing:
if any section already has it, nothing is created (`409`). → `201 {items: [ClassSubject]}`

## Students

| Route | Permission | Notes |
|---|---|---|
| `GET /students?status=` | read_assigned | *paginated*; teachers get only students currently in their sections |
| `POST /students` | students.manage | `{studentNumber?, fullName, dateOfBirth?}` |
| `GET /students/:studentId` | read_assigned | adds `currentEnrollments` |
| `PATCH /students/:studentId` | students.manage | `{fullName?, dateOfBirth?: date\|null}` |
| `POST /students/:studentId/status` | students.manage | see below |
| `GET /students/:studentId/enrollments` | read_assigned | full history incl. voided rows |

`studentNumber` is school-issued, 1–32 of `A-Z 0-9 / -` (upper-cased), unique **within the school**
(`409`). Omit it and the server issues the next number from a per-school counter
(`000001`, `000002`, …), skipping numbers already taken. It is an identifier, not a secret.

Only name and optional date of birth are stored; teachers never receive `dateOfBirth`.
Aadhaar, addresses, guardian data and similar fields are not accepted (unknown keys are stripped).

**Status**: body is one of
- `{"status": "withdrawn", "effectiveDate"}` / `{"status": "transferred", "effectiveDate"}` — ends
  every current placement on that date (`endReason` `withdrawn` / `transferred_out`) and voids any
  placement that had not yet started, in one transaction. Only from `active` (`409` otherwise).
- `{"status": "active"}` — readmission; enrol again explicitly afterwards.

A transfer to another school on the platform creates a new student record there; this one
stays as history.

## Enrolments

| Route | Permission | Body |
|---|---|---|
| `POST /academic-years/:yearId/enrollments` | students.manage | `{studentId, sectionId, effectiveFrom}` → `201` |
| `POST /enrollments/:enrollmentId/transfer` | students.manage | `{sectionId, effectiveDate}` → `201` (new row) |
| `POST /enrollments/:enrollmentId/void` | students.manage | `{reason}` → `200` |
| `POST /academic-years/:targetYearId/promotions` | students.manage | `{effectiveFrom, items: [{enrollmentId, sectionId}] (1–200)}` → `201 {items}` |
| `GET /sections/:sectionId/roster?date=` | read_assigned | *paginated*; students placed in the section on that date |

`Enrollment`: `{id, studentId, academicYearId, sectionId, effectiveFrom, effectiveTo, endReason, voided, previousEnrollmentId}`.
A placement covers `[effectiveFrom, effectiveTo)`; `effectiveTo: null` means current.

- **Enrol**: student must be `active`; section must be in that year; date inside the year (`422`).
  A second placement covering any of the same days in the year → `409` (also under concurrency).
- **Transfer** (between sections of the same year): ends the current row on `effectiveDate` and
  opens a new one linked by `previousEnrollmentId`. `effectiveDate` must be after the row began —
  a same-day change is a correction; use void (`422`).
- **Void**: for a placement entered by mistake. The row is kept with its reason and flagged
  `voided`; it no longer counts. Only the latest row of a chain can be voided (`409`).
- **Promotion**: each source must be the student's current enrolment in an earlier year; it is ended
  the day after that year's last day (`endReason: "promoted"`) and a linked row opens in the target
  year. Target class ≥ source class (same class = repeating). All-or-nothing; a failure returns
  `422` with `fields[].path` like `items.3.sectionId`.
- **Roster**: live enrolments covering `date`, regardless of the student's *current* status — a
  pupil who withdrew in December is still on November's roster.

Every write is audited (`audit_logs`) with ids, dates and outcomes, never names or free text.
Rows are never deleted or rewritten; the database enforces this with triggers.

## Teacher assignments

| Route | Permission | Body / query |
|---|---|---|
| `GET /teacher-assignments?academicYearId=&includeEnded=` | read_own | *paginated*; admins see all, teachers their own |
| `POST /academic-years/:yearId/teacher-assignments` | teacher_assignments.manage | `{classSubjectId, membershipId}` → `201` |
| `POST /teacher-assignments/:assignmentId/end` | teacher_assignments.manage | → `200` |

`membershipId` is the staff member's school membership (from `GET /staff`). It must be
**active** and in a teaching role (`teacher` or `school_admin`) — otherwise `422`; a membership
of another school is `404`. The same active assignment twice → `409`. Ended assignments remain
listable with `includeEnded=true`.

---

# Slice 3 — Guardian linking and parent phone identity

## Parent phone login (Public)

### `POST /auth/otp/request`
`{"phone": "98450 12345", "purpose"?: "guardian_login"}` → `202 {"status": "accepted", "expiresInSeconds": 300}`

- The **same** response for every valid Indian mobile number, known or not. Every such number
  gets a challenge, so neither body nor timing reveals whether an account exists.
- `accepted` means the request was accepted — **not** that an SMS reached a phone.
- `503 SERVICE_UNAVAILABLE` when no SMS provider is configured or the provider failed. This depends
  only on the server, never on the number. On failure the code is withdrawn.
- A new code invalidates any previous one for that phone.
- Limits: 1 code per phone per minute (`429` + `Retry-After`), 5 per phone per hour, 20 per IP per
  hour, 1,000 per hour overall (SMS-pumping ceiling). Per API instance.

### `POST /auth/otp/verify`
`{"phone", "code": "6 digits", "purpose"?}` → `200 IssuedTokens` (same shape as `/auth/login`).

- Every failure — wrong code, expired, already used, too many attempts, unknown phone — is
  `400 INVALID_OR_EXPIRED_TOKEN "Invalid or expired code"`.
- Codes expire after `OTP_TTL_SECONDS` (default 300), allow `OTP_MAX_ATTEMPTS` (default 5)
  attempts, and are single-use; simultaneous correct submissions produce exactly one session.
- 10 wrong codes per phone per hour locks verification for that phone (`429`, even for the right
  code); 60 attempts per IP per 15 minutes.
- On success the phone's account is found or created. **The account grants nothing by itself**:
  children become visible only through school-verified links.

## Parent endpoints (authenticated)

Access to a child requires, on every request: the caller's OTP-verified phone → a school's
guardian record with that phone → a link with status `verified` → a student in an `active`
school. Knowing a student's id, number or date of birth adds nothing. Anything outside that
chain is `404`, identical to a random id.

| Route | Response |
|---|---|
| `GET /parents/me/children` | `{items: [Child]}` — verified links only; empty for staff accounts |
| `GET /parents/me/children/:studentId` | `Child` · `404` unless verified-linked |
| `POST /parents/me/link-requests` | `202 {"status": "submitted"}` |
| `GET /parents/me/link-requests` | `{items: [{id, submittedAt, schoolCode, studentNumber, relationshipType, status}]}` |

`Child`: `{studentId, fullName, studentNumber, studentStatus, schoolId, schoolName,
relationshipType, currentPlacement: {academicYearName, gradeNumber, sectionName} | null}` — no
date of birth.

**Link requests**: body `{schoolCode, studentNumber, relationshipType, guardianName}`.
Requires a phone login (`403` for staff accounts); 10 per user per day. The response is identical
whether or not the school code and student number match an active student. On a match, a
**pending** link is created (or an existing live one reused) against the school's guardian record
for the caller's verified phone — an existing record's name is never overwritten. A request never
verifies anything. Request status: `pending` (awaiting review **or** matched nothing —
deliberately indistinguishable), `approved`, `declined` (after a reviewer rejected or revoked).

`relationshipType` ∈ `mother`, `father`, `grandparent`, `sibling`, `relative`, `legal_guardian`, `other` —
stored on the link (D-07).

## School staff: guardians and links

Permissions `school.guardians.read` / `school.guardians.manage` — **school admins only**.
Teachers `403`; other schools, the platform admin and parents `404`.

| Route | Permission | Body / query |
|---|---|---|
| `GET /schools/:schoolId/guardians?phone=` | read | *paginated* |
| `POST /schools/:schoolId/guardians` | manage | `{fullName, phone}` — unique phone per school (`409`) |
| `GET /schools/:schoolId/guardians/:guardianId` | read | record + all its links |
| `PATCH /schools/:schoolId/guardians/:guardianId` | manage | `{fullName?, phone?}` — phone may change only with no pending/verified links (`409`) |
| `GET /schools/:schoolId/students/:studentId/guardian-links` | read | all links incl. history |
| `POST /schools/:schoolId/students/:studentId/guardian-links` | manage | `{guardianId, relationshipType}` → `201`, `pending` |
| `GET /schools/:schoolId/guardian-links?status=pending` | read | review queue, *paginated* |
| `POST /schools/:schoolId/guardian-links/:linkId/verify` | manage | → `200` |
| `POST /schools/:schoolId/guardian-links/:linkId/reject` | manage | `{reason}` → `200` |
| `POST /schools/:schoolId/guardian-links/:linkId/revoke` | manage | `{reason}` → `200` |

Guardian records hold only a name and an E.164 mobile number; other fields are stripped.

`GuardianLink`: `{id, studentId, studentName, studentNumber, studentStatus, guardianId,
guardianName, guardianPhone, relationshipType, status, initiatedVia: "school"|"guardian_claim",
createdAt, verifiedAt, rejectedAt, revokedAt, statusReason, otherLiveLinksForStudent}`.
`otherLiveLinksForStudent` counts other pending/verified links on the same student so a reviewer
sees conflicting claims.

**Workflow**: `pending → verified | rejected`, `verified → revoked`; rejected and revoked are final
(`409` otherwise); a new link may follow them. Links are created only for `active` students and
verified only while the student is `active` (`422`). A reviewer cannot verify a link whose
guardian phone is their own (`403`). Two reviewers verifying at once: one `200`, the others `409`.
Revocation takes effect on the parent's next request. Each step records who and when on the
link and in `audit_logs`; the reason stays on the link.

**Students who leave**: a withdrawn or transferred student keeps existing verified links — the
parent still sees the child, with `studentStatus` and `currentPlacement: null` — until the school
revokes them. A transfer to another school needs that school's own verified link; nothing carries
across schools.

---

# Slice 4 — Attendance

Per-period, per-subject registers (Q1). All staff routes are under `/schools/:schoolId/…`.

### Permissions

| Permission | `school_admin` | `teacher` |
|---|---|---|
| `school.attendance.mark` — open, read and submit registers | ✓ any class-subject | ✓ **only class-subjects with an active assignment** |
| `school.attendance.read_all` — every register in the school | ✓ | — |
| `school.attendance.correct` — change submitted attendance | ✓ | — |

A teacher without an active assignment to a register's class-subject gets `403` (the
class-subject is visible structure). Anything in another school — or for the platform admin or a
parent on a school route — is `404`. The assignment is re-checked on every request.

### Date and year policy

- Only the school's **active** academic year accepts attendance (planned / closed / archived → `409`).
  Closed years stay readable.
- The date must be inside the year and **not in the future**, "today" being computed in
  `ATTENDANCE_TIMEZONE` (default `Asia/Kolkata`) → `422`.
- Teachers may go back at most `ATTENDANCE_TEACHER_BACKDATE_DAYS` (default 7) → `422`;
  school admins may use any date of the active year.
- Weekends and holidays are not checked (calendar arrives in a later slice).

## Registers

| Route | Permission | Notes |
|---|---|---|
| `POST /attendance/sessions` | mark | `{classSubjectId, sessionDate, period: 1–12}` → `201` created / `200` already existed |
| `GET /attendance/sessions?date=&sectionId=&classSubjectId=` | mark | *paginated*; teachers see only their class-subjects |
| `GET /attendance/sessions/:sessionId` | mark | register + counts |
| `PUT /attendance/sessions/:sessionId/records` | mark | header **`Idempotency-Key: <uuid>`**; body `{records: [{studentId, status}]}` |
| `POST /attendance/sessions/:sessionId/corrections` | correct | `{studentId, status, reason}` → `201` |
| `GET /attendance/sessions/:sessionId/corrections` | mark | full correction history |
| `GET /students/:studentId/attendance?from=&to=` | `school.students.read` (admins) | per-period entries + summary |

`status` ∈ `present`, `absent`, `late`, `approved_leave` (FR-007). `present` and `late` count as
attended (`PRESENT_EQUIVALENT_STATUSES` in `@smart-school/shared`).

**One register per section, date and period.** Opening the same (class-subject, date, period)
again returns the existing register; a different subject already in that section's period is `409`.

`AttendanceSessionDetail`: `{id, academicYearId, sectionId, sectionName, gradeNumber,
classSubjectId, subjectCode, sessionDate, period, status: "open"|"submitted", submittedAt,
register: [{studentId, studentNumber, fullName, enrollmentId, effectiveFrom, status|null,
corrected}], counts: {onRoster, marked, unmarked}}`.

**Roster.** The students whose live enrolment in the section covers the session date — the same
resolver as `GET /sections/:id/roster`. Pupils who join later, moved to another section, or left
before the date are not on it; a pupil who leaves later still is.

**Submission** (no partial registers):
- `records` must list **exactly** the roster: missing or extra ids → `422` with
  `fields[].message` `missing: …` / `not on the roster: …`. Duplicate ids or unknown statuses → `400`.
- All records and the session's `submitted` state are written in **one transaction**. Any failure
  leaves the register `open` with no records.
- Idempotency: same key + same payload (in any order) → `200` with `replayed: true`, nothing
  written again · same key + different payload → `409 IDEMPOTENCY_KEY_REUSED` · any other
  submission to a submitted register → `409 STATE_CONFLICT` (use corrections).

**Corrections** (school admins, reason required, submitted registers only, active year only):
append `{revision, oldStatus, newStatus, reason, correctedBy, correctedAt}` to the history and
update the record. `oldStatus: null` means the pupil was unmarked — e.g. enrolled afterwards with
a backdated start — and the correction marks them. Correcting to the same status → `422`; a
pupil not on the register → `404`. The reason is kept on the correction; audit logs carry ids and
statuses only.

**Unmarked is not absent (D-11).** A pupil without a record is `status: null` on the register and
is not counted in any summary.

**Enrolment history is protected.** Once attendance is recorded against a placement:
voiding it → `409`; transferring or withdrawing the pupil with an effective date **on or before**
a date that has attendance → `409` (a later date works, and the recorded attendance stays).

## Parents

`GET /parents/me/children/:studentId/attendance?from=&to=` (range ≤ 366 days) — only through a
verified guardian link, re-checked per request; otherwise `404`.

```json
{
  "from": "2026-09-01", "to": "2026-09-30",
  "items": [{ "date": "2026-09-02", "period": 1, "subjectCode": "MATH", "subjectName": "Mathematics",
              "status": "present", "corrected": false }],
  "summary": { "basis": "periods", "periodsMarked": 42, "attendedPeriods": 40,
               "byStatus": { "present": 38, "absent": 2, "late": 2, "approved_leave": 0 },
               "attendanceRate": 0.9524 }
}
```

`basis: "periods"` is part of the contract: the rate is over marked **periods**, not days, and
must not be presented as a daily attendance percentage. Correction reasons are not shown.

**Students:** there is no student self-view yet — students have no login linkage
(`students.user_id`, D-05, is not built), so there is no identity to authorize against.

---

# Slice 5 — Attendance reports

All reports are **read-only and derived on request** from registers, records and enrolments, so a
correction is reflected immediately and there are no stored totals to go stale. Nothing is
cached. Every metric is counted in **periods**; there is no daily attendance rate.

## Definitions (returned as `definitions` in every report)

| Term | Meaning |
|---|---|
| eligible student-period | a register (section, date, period) × a student whose live enrolment in **that** section covers the date |
| marked | eligible and has a record: `present`, `absent`, `late`, `approved_leave` |
| unmarked | eligible, no record (register still open, or pupil enrolled later with a backdated start). **Never counted as absent.** |
| `attendanceRate` | `(present + late) / marked` — `approved_leave` **is** in the denominator (same formula as Slice 4); `null` when marked = 0 |
| `markingCompleteness` | `marked / eligible`; `null` when eligible = 0 |
| `registers.submissionRate` | `submitted / opened` registers in the range. **Only registers that were actually opened are counted. It is not the share of timetabled periods that should have had a register** — no timetable exists yet, so a register that was never opened is invisible to every metric (and never produces absences). |
| `daysWithRegisters`, `daysWithAnyMark` | distinct dates with ≥ 1 counted register / ≥ 1 marked period. Day counts only — no daily rate. |

A pupil who changes section mid-range is counted in each section only for the dates they were
in it (enrolments cannot overlap). At class and school level, `distinctStudents` counts each
pupil once — it is not the sum of section rows.

## Query parameters

`from`, `to`: `YYYY-MM-DD`, `from ≤ to`, at most 366 days (`400` otherwise). Optional filters are
re-resolved inside the caller's school — another school's id is `404`, as is an unknown one:

| Filter | Validation |
|---|---|
| `academicYearId` | in the school (`404`); must overlap the range (`422`) |
| `gradeId` | in the school (`404`) |
| `sectionId` | in the school (`404`); must belong to `academicYearId` / `gradeId` when given (`422`); teachers: must have an active assignment in it (`403`) |
| `groupBy` (sections report) | `section` (default) or `period` |

## Endpoints

| Route | Who |
|---|---|
| `GET /schools/:schoolId/attendance/reports/sections` | `school.attendance.mark` — admins: all registers; teachers: **only registers of class-subjects they are actively assigned to** |
| `GET /schools/:schoolId/attendance/reports/sections.csv` | same |
| `GET /schools/:schoolId/attendance/reports/summary` | `school.attendance.read_all` (school admins) |
| `GET /schools/:schoolId/attendance/reports/summary.csv` | same |
| `GET /schools/:schoolId/attendance/reports/students/:studentId` | admins: any student of the school; teachers: only students **currently** in a section they actively teach (`404` otherwise), limited to their class-subjects |
| `GET /schools/:schoolId/students/:studentId/attendance` | admins (Slice 4 route) — now returns the same student report |
| `GET /parents/me/children/:studentId/attendance` | verified guardian link, re-checked per request — same student report, own child only |

Teachers lose access on the next request when an assignment ends. Other schools, the platform
admin and parents on school routes get `404`. Reports never rank sections and never list
individual children; rows are ordered by class, then section name, then period.

### Sections / summary response

```jsonc
{
  "included": { "from": "…", "to": "…", "academicYearId": null, "gradeId": null, "sectionId": null,
                "registers": "all registers in the school" },   // or "registers of class-subjects you are actively assigned to"
  "rows": [ ReportRow ],                                          // sections report
  // summary instead returns: "total": ReportRow, "grades": [ReportRow], "sections": [ReportRow]
  "definitions": { … }
}
```

`ReportRow`:
```jsonc
{
  "gradeNumber": 5, "sectionId": "…", "sectionName": "A", "period": null,   // nulls at higher levels
  "registers": { "opened": 3, "submitted": 2, "open": 1, "submissionRate": 0.6667, "daysWithRegisters": 2 },
  "studentPeriods": { "eligible": 9, "marked": 6, "unmarked": 3, "attended": 4,
                      "byStatus": { "present": 3, "absent": 1, "late": 1, "approved_leave": 1 },
                      "markingCompleteness": 0.6667 },
  "attendanceRate": 0.6667,
  "distinctStudents": 4,
  "daysWithAnyMark": 1
}
```

The school summary's total, class and section rows are read from **one database snapshot**, so
they always agree.

### Student report (admins, teachers, parents)

```jsonc
{
  "from": "…", "to": "…",
  "items": [ { "date": "…", "period": 1, "gradeNumber": 5, "sectionName": "A",      // class/section ON THAT DATE
               "subjectCode": "MATH", "subjectName": "Mathematics",
               "status": "late",            // null = unmarked
               "corrected": false } ],
  "summary": { "basis": "periods", "eligiblePeriods": 3, "periodsMarked": 3, "unmarkedPeriods": 0,
               "attendedPeriods": 2, "byStatus": { … }, "attendanceRate": 0.6667,
               "markingCompleteness": 1, "daysWithRegisters": 2, "daysWithAnyMark": 2 },
  "definitions": { … }
}
```

**Change from Slice 4** (no released client depends on it yet): `items` now include **unmarked**
eligible periods with `status: null`, and each item carries `gradeNumber` and `sectionName`.
Slice 4 summary fields keep their names and meaning; `eligiblePeriods`, `unmarkedPeriods`,
`markingCompleteness`, `daysWithRegisters` and `daysWithAnyMark` are added. No classmate's data
and no correction reason is ever included.

## CSV export

`sections.csv` and `summary.csv` run exactly the same authorization, filters and scoping as the
JSON reports. **Aggregate rows only** — no student names, numbers or ids. UTF-8 with BOM, CRLF,
`Content-Disposition: attachment`, `Cache-Control: no-store`.

Columns: `range_from, range_to, registers_included | level, grade_number, section_name, [period],`
then `registers_opened, registers_submitted, registers_open, register_submission_rate,
eligible_student_periods, marked_student_periods, unmarked_student_periods, present, absent, late,
approved_leave, attended_student_periods, attendance_rate, marking_completeness, distinct_students,
days_with_registers, days_with_any_mark`. `summary.csv` has a `level` column (`school` / `class` /
`section`) instead of `registers_included`.

**Formula injection:** any text cell whose first non-space character is `= + - @`, or that starts
with a tab or carriage return, is prefixed with `'` (section names are school-entered free text).
Each successful export writes an `attendance_report.exported` audit row (report, range, filters,
row count, scope); denied requests write nothing.
