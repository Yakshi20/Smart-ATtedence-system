# Smart School Management System

Multi-tenant school management platform for government and private schools in Karnataka,
India, initially covering Classes 1–7.

**Status: Slice 0 (foundation) complete.** There is no domain functionality yet — see
[docs/decisions/02_BACKLOG.md](docs/decisions/02_BACKLOG.md) for what is built and what is next.

## Read these first

| Document | Purpose |
|---|---|
| [docs/blueprint/](docs/blueprint/) | The product specification, committed unmodified |
| [docs/decisions/00_ANALYSIS_AND_OPEN_DECISIONS.md](docs/decisions/00_ANALYSIS_AND_OPEN_DECISIONS.md) | Contradictions and gaps found in the blueprint, with resolutions |
| [docs/decisions/01_ARCHITECTURE_PROPOSAL.md](docs/decisions/01_ARCHITECTURE_PROPOSAL.md) | Structure, auth, authorization model, testing strategy |
| [docs/decisions/02_BACKLOG.md](docs/decisions/02_BACKLOG.md) | Ordered slices and their acceptance tests |

## Requirements

- Node.js 22+
- pnpm 10+
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

## Layout

```text
apps/api          NestJS REST API — the only writer to the database
apps/web          Next.js portals (not yet created)
apps/mobile       Expo app (not yet created)
packages/database Drizzle schema, migrations, test-database harness
packages/shared   Error codes and shared schemas
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
