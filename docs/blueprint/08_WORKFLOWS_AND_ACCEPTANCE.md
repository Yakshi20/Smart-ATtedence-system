# 08 — Core Workflows and Acceptance Criteria

## 1. School registration
1. School submits request.
2. Authorized reviewer verifies identity and relevant records.
3. Approve, reject or request clarification.
4. Approved school receives unique code.
5. Administrator membership is created securely.
6. Configure academic year, classes, sections and subjects.
7. Import roster and teachers.
8. Validate records and activate the school.

Acceptance:
- Unapproved school cannot use production academic workflows.
- School code is unique.
- Approval history is recorded.
- School administrator cannot access another school's records.

## 2. Daily attendance
1. Teacher signs in.
2. Selects an assigned class and attendance session.
3. System loads the correct enrolled roster.
4. Teacher marks status.
5. API validates role, assignment, session and roster.
6. Attendance is saved in a transaction.
7. Audit record is stored.
8. Notifications are queued after successful commit.
9. Reports update.

Acceptance:
- Duplicate student/session record is rejected or idempotently handled.
- Unmarked is not silently treated as absent.
- Unauthorized class is denied.
- Corrections require authorized workflow and reason.
- Parent sees only linked child's attendance.
- Failed submission clearly remains unsubmitted.

## 3. Marks publication
1. Authorized user creates examination and subject configuration.
2. Teacher enters draft marks.
3. API validates enrollment, maximum marks and assessment state.
4. Teacher submits for review.
5. Authorized reviewer approves or returns for correction.
6. Publication transaction records publication and grading configuration version.
7. Report card is generated or queued.
8. Linked students/parents receive notification.

Acceptance:
- Scores outside allowed range are rejected.
- Draft/unapproved marks are not visible to student/parent.
- Published results have a clear publication timestamp.
- Changes to published results require an auditable correction/republication workflow.
- Calculation uses the configured grading version.

## 4. Parent linking
1. Parent account is verified.
2. School/authorized workflow confirms the relationship.
3. Link is activated and logged.
4. Parent can select linked children.
5. Every child-specific API checks the relationship.
6. Revocation immediately blocks future requests.

Acceptance:
- A parent cannot retrieve an unrelated child's records by changing IDs.
- Multiple verified children work.
- Revoked links cannot read records through stale authorization.
- No public student enumeration endpoint exists.

## 5. District reporting
1. Officer signs in with active district membership.
2. Selects an allowed reporting period and filters.
3. API validates district scope and permission.
4. Aggregate query applies the authorized scope.
5. Export is generated asynchronously if needed.
6. Download is time-limited and audited.

Acceptance:
- Officer cannot query another district without authorization.
- Report includes only permitted data fields.
- Export access is logged.
- Aggregate data is distinguished from student-level data.

## 6. Release acceptance checklist
- [ ] Cross-school isolation tests pass.
- [ ] Cross-student parent access tests pass.
- [ ] Teacher assignment tests pass.
- [ ] Duplicate attendance test passes.
- [ ] Attendance correction audit test passes.
- [ ] Draft marks remain private.
- [ ] Mark range and grading configuration tests pass.
- [ ] Published result correction test passes.
- [ ] Calendar targeting tests pass.
- [ ] Bulk import validation and recovery tests pass.
- [ ] Notification retries are safe.
- [ ] File authorization and expiry tests pass.
- [ ] District scope and export tests pass.
- [ ] Backup restoration is demonstrated.
- [ ] English and Kannada interfaces are reviewed.
- [ ] Privacy/security review is completed.
- [ ] Load test meets agreed service targets.

A checkbox is complete only after the corresponding test or review is actually run and evidence is recorded.
