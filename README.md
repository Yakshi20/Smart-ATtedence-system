# Smart School Management System

Multi-tenant school management platform for government and private schools in Karnataka,
India, initially covering Classes 1–7.

**Status: Slices 1–5 complete** — school registration and platform approval, staff login with
refresh-token rotation, school-scoped access control, academic years, classes, sections,
subjects, students, enrolment history, teacher assignments, guardian linking, parent phone
(OTP) login, per-period attendance with corrections, and attendance reports (school, class,
section, student, parent) with CSV export. See [docs/decisions/02_BACKLOG.md](docs/decisions/02_BACKLOG.md)
for what is built and what is next, and [docs/api/README.md](docs/api/README.md) for the API.

## Read these first

| Document | Purpose |
|---|---|
| [docs/blueprint/](docs/blueprint/) | The product specification, committed unmodified |
| [docs/decisions/00_ANALYSIS_AND_OPEN_DECISIONS.md](docs/decisions/00_ANALYSIS_AND_OPEN_DECISIONS.md) | Contradictions and gaps found in the blueprint, with resolutions |
| [docs/decisions/01_ARCHITECTURE_PROPOSAL.md](docs/decisions/01_ARCHITECTURE_PROPOSAL.md) | Structure, auth, authorization model, testing strategy |
| [docs/decisions/02_BACKLOG.md](docs/decisions/02_BACKLOG.md) | Ordered slices and their acceptance tests |
| [docs/api/README.md](docs/api/README.md) | API reference: routes, errors, auth and tenancy rules |

## Requirements

- Node.js 22+
- pnpm 11 (pinned via `packageManager` in package.json; `corepack enable` picks it up)
- Podman or Docker (for PostgreSQL 16)

## Getting started

```bash
pnpm install
cp .env.example .env          # then set real values; see the notes below
pnpm db:up                    # PostgreSQL 16 on 127.0.0.1:55432
pnpm -r build
pnpm db:migrate
pnpm test
```

To use the API locally you need a platform admin, which only a shell can create:

```bash
read -rs PLATFORM_ADMIN_PASSWORD && export PLATFORM_ADMIN_PASSWORD
pnpm --filter @smart-school/api platform-admin:create --email you@example.org --name "Your Name"
```

Activation tokens for newly approved school admins and invited staff are written to the API
log in development (no email provider has been chosen yet). The API refuses to start in
production until one is configured.

Parent login uses a phone OTP. **No SMS provider has been chosen.** In development
(`SMS_PROVIDER=dev_outbox`) codes are held in process memory and are never logged, so the parent
flow can currently be exercised only by the automated tests. `SMS_PROVIDER=none` disables it (503).

`.env` needs two things filled in:

- Replace `CHANGE_ME` in the two connection strings with the password from
  `infrastructure/compose.yaml` (`devpass` for local development).
- Generate a secret: `openssl rand -base64 48` into `JWT_ACCESS_SECRET`.

## Scripts

| Command | Effect |
|---|---|
| `pnpm db:up` / `pnpm db:down` | Start / stop PostgreSQL |
| `pnpm db:migrate` | Apply pending migrations (idempotent) |
| `pnpm -r build` | Compile all packages in dependency order |
| `pnpm typecheck` | Typecheck everything (run after a build) |
| `pnpm lint` | ESLint |
| `pnpm test` | Full suite, against a real PostgreSQL |
| `pnpm --filter @smart-school/api platform-admin:create` | Create or promote a platform admin |

## Layout

```text
apps/api          NestJS REST API — the only writer to the database
apps/web          Next.js portals (not yet created)
apps/mobile       Expo app (not yet created)
packages/database Drizzle schema, migrations, test-database harness
packages/shared   Error codes and shared request schemas (zod)
packages/permissions  Permission registry and role defaults (pure, no I/O)
packages/config   tsconfig and Jest bases
infrastructure/   compose.yaml for local and CI dependencies
```

## Testing

Tests run against a **real PostgreSQL**, never a mock or SQLite. The tenant-isolation
guarantees this platform depends on are database constraints — composite foreign keys that
make a cross-school row unrepresentable — and a mocked repository cannot enforce them, so a
test against one would prove nothing.

Each test file provisions a uniquely named, freshly migrated database and drops it on
teardown. If a run crashes before teardown, the next run reaps any test database older than
an hour.

`pnpm test` fails with a clear message if `TEST_DATABASE_ADMIN_URL` is unset rather than
silently skipping the integration tests.

## Security notes

- No secrets in source control. `.env.example` holds placeholders only; `.env` is gitignored.
- The local PostgreSQL runs with `fsync=off` for speed. It holds only development and
  throwaway test data — **never** apply those flags where real school data lives.
- Authorization is enforced server-side on every request. Access tokens carry no roles or
  scopes, so a revoked permission takes effect on the very next request; the reasoning is in
  the architecture proposal.
- Every route requires authentication unless explicitly marked `@Public()`; a test pins the
  public route list.
- Passwords are argon2id. Refresh and activation tokens are stored only as SHA-256 hashes; OTP
  codes only as an HMAC, never logged.
- Parents see a child only through a school-verified guardian link, re-checked on every request.
- Attendance history is append-only: records change only through a reasoned correction, and
  enrolment history cannot be altered in a way that contradicts recorded attendance.
- Rate limits are in-process per API instance. Set `TRUST_PROXY` behind a load balancer.
