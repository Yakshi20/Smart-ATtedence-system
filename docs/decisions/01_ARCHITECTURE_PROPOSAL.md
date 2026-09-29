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
