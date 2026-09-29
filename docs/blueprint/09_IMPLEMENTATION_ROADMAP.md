# 09 — Implementation Roadmap and Rollout

## Guiding approach
Design for the full product, but release progressively. A district-wide target does not mean all schools should be activated on the same day.

## Phase 1 — Foundation
- Monorepo, CI and environment setup
- Database schema/migrations
- Identity, sessions and account recovery
- School onboarding and membership
- Role/permission framework
- Tenant isolation tests
- Initial web shell and mobile shell

Exit criteria: authorized users can sign in; school boundaries are tested.

## Phase 2 — Academic setup
- Academic years
- Classes 1–7 and sections
- Subjects and class-subject mapping
- Students and enrollments
- Teacher profiles and assignments
- Parent verification/linking
- Validated spreadsheet import

Exit criteria: a school can create and validate its roster.

## Phase 3 — Daily operations
- Attendance sessions and records
- Attendance correction workflow
- Timetable versioning
- Homework and attachments
- Holidays and announcements
- Parent/student views
- Notifications and delivery tracking

Exit criteria: teacher marks attendance and a verified parent sees only their child's record.

## Phase 4 — Exams and reporting
- Assessment schemes
- Exam setup and schedules
- Marks grid and validation
- Review/approval/publication
- Grade calculation and report cards
- School-level reports and exports

Exit criteria: a configurable assessment can be completed end to end.

## Phase 5 — District portal
- District school directory
- Enrollment and attendance summaries
- Exam completion monitoring
- Authorized academic summaries
- District notices
- Asynchronous exports and audit

Exit criteria: reports respect district scope and data minimization.

## Phase 6 — Production readiness
- Security review and penetration testing
- Load/performance tests
- Backup restoration drill
- Monitoring and incident response
- Privacy/legal review
- English/Kannada QA
- Accessibility review
- Support documentation and training materials

Exit criteria: documented release approval and operational readiness.

## Phase 7 — Staged rollout
- Internal test environment
- Small pilot cohort (for example 2–5 willing schools)
- Staff and parent onboarding
- Observe actual workflows and support requests
- Fix critical issues and repeat acceptance tests
- Expand in batches by district/administrative area
- Maintain rollback, communication and support plans

## Planning estimate
An illustrative small-team plan might use 2–3 sprints for foundation, 2 for academic setup, 3 for daily operations, 3 for exams, 3 for district reporting, and 3 for production readiness. These are not commitments; integrations, procurement, migration, team size and legal review may change the schedule.

## Suggested team
- Product/domain owner
- UI/UX designer (especially early)
- 2 full-stack/backend engineers
- 1 mobile engineer (can overlap in a small team)
- QA engineer
- Part-time DevOps/security support
- Legal/privacy advisor

## Metrics
- Active schools / onboarded schools
- Validated student records
- Daily attendance completion rate
- Time to submit attendance
- Homework/timetable publication
- Exam marks completion and publication on time
- Parent account activation
- Notification delivery success
- Import error and correction rate
- Support response/resolution time
- Unauthorized-access test results and incidents

## Operational readiness
- School verification SOP
- Training guides
- Import templates and data-quality checks
- Support escalation process
- Backup and restore schedule
- Incident response
- Data retention and deletion
- Access reviews
- Vendor management
- Release/change management
