# 04 — Technical Architecture

## 1. Recommended stack

- Mobile: React Native + Expo + TypeScript
- Web: Next.js + TypeScript
- Backend: Node.js + NestJS, REST API
- Database: PostgreSQL
- ORM/migrations: Drizzle ORM
- Authentication: managed identity provider or reviewed secure custom implementation
- Files: private S3-compatible object storage
- Jobs/queue: Redis + BullMQ or equivalent
- Push: mobile push provider; SMS gateway for OTP/alerts where approved
- Monitoring: structured logs, metrics, error tracking and alerts
- Hosting: managed cloud region selected after legal, contractual, latency and cost review

Do not assume a provider, government integration, or paid service has been approved. Keep integrations behind interfaces and document configuration.

## 2. High-level architecture

Clients (mobile and web)
→ REST API / application boundary
→ authentication and authorization
→ domain modules
→ PostgreSQL, private object storage, job queue and notification providers.

## 3. Backend modules
- Identity and authentication
- Tenancy and school onboarding
- District administration
- Academic structure and enrollment
- Guardian relationships
- Staff and teacher assignments
- Attendance
- Timetable and calendar
- Homework and materials
- Examination and grading
- Report cards
- Announcements and notifications
- Imports and exports
- Audit and compliance
- Billing (optional)

## 4. Architecture style
Start with a modular monolith. Keep module boundaries clear, but deploy the API as one application initially. Use background workers for long-running jobs and notifications. Extract microservices only when measured scale or organizational needs justify the added operational complexity.

## 5. Repository structure

```text
smart-school/
├── apps/
│   ├── mobile/             # Expo / React Native
│   ├── web/                # Next.js portals
│   ├── api/                # NestJS REST API
│   └── worker/             # Queue workers
├── packages/
│   ├── database/           # Drizzle schema and migrations
│   ├── shared/             # Shared types and validators
│   ├── permissions/        # Policy definitions
│   ├── i18n/               # English/Kannada/translations
│   ├── ui/                 # Shared web UI components
│   └── config/             # TypeScript/lint/tooling
├── infrastructure/
├── docs/
├── tests/
│   ├── integration/
│   ├── authorization/
│   └── e2e/
├── pnpm-workspace.yaml
└── README.md
```

## 6. Engineering conventions
- TypeScript strict mode.
- Request validation at API boundaries.
- Centralized authorization policy checks.
- Centralized error handling.
- OpenAPI/Swagger documentation.
- Database migrations committed to version control.
- No secrets in source control; `.env.example` contains placeholders only.
- Structured logs with correlation/request IDs; do not log unnecessary student data.
- API pagination, filtering and stable sorting for list endpoints.
- Transactions for attendance submission and marks publication.
- Idempotency for retry-prone operations.
- Background jobs for bulk imports, exports and notification delivery.
- CI checks: lint, typecheck, unit tests, integration tests and migration checks.

## 7. Data flows
### Attendance
Teacher client → authorized API → roster/session validation → database transaction → audit entry → queue notification → parent delivery.

### Marks
Teacher client → draft marks API → range/enrollment validation → review workflow → authorized publication transaction → report generation → notifications.

### Files
Client requests upload authorization → API validates scope and metadata → short-lived upload URL → storage → server-side verification/scanning where available → authorized download link.

### Reports
Authorized user requests report → scope is resolved server-side → asynchronous report job → file stored privately → short-lived download link → request/download audit.

## 8. Deployment environments
- Local development
- Shared test/staging
- Production
- Separate credentials, storage buckets and databases per environment.
- Automated database migrations with review and rollback/recovery plan.
- Secrets manager for production credentials.
- Restrict production data access.
- Run backups and restoration drills.
