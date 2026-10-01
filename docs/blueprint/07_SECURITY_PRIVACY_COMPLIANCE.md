# 07 — Security, Child Privacy and Compliance

## 1. Security requirements
- TLS for all network traffic.
- Secure password/PIN handling; never store plaintext credentials.
- OTP expiry, rate limits, abuse detection and recovery protections.
- Secure session expiry, rotation where applicable and revocation.
- Stronger authentication for privileged users.
- Server-side authorization for every protected request.
- School-level tenant isolation in application queries and database constraints.
- Consider PostgreSQL row-level security as defense in depth.
- Input validation, output encoding and parameterized database queries.
- CSRF protections where cookie-based browser sessions are used.
- Rate limits on login, OTP, search, exports and file operations.
- Private object storage and short-lived signed links.
- File size/type checks, malware scanning where available and safe filenames.
- Secret management and environment separation.
- Dependency scanning, patch management and secure CI/CD.
- Encryption at rest where supported by the hosting/database/storage services.
- Backups, restoration drills and incident-response runbook.
- Audit sensitive actions and exports.
- Minimize personal data in logs and analytics.

## 2. Threat scenarios to test
- Parent changes a student ID in a URL/API request.
- Teacher changes school or section ID to access another class.
- Principal attempts access to another school.
- District officer attempts access outside assigned jurisdiction.
- Student guesses or enumerates student IDs.
- Revoked guardian retains access through a stale session/cache.
- Signed file URL is reused after expiry.
- Marks are changed after publication without approval.
- Duplicate or replayed attendance submission.
- Bulk export is requested outside the caller's scope.
- Support user accesses academic records without approved justification.
- Notification leaks marks, health or personal data on a lock screen.

## 3. Child-data privacy
The platform handles children's data. Before production, obtain qualified legal review of India's Digital Personal Data Protection Act, 2023, the Digital Personal Data Protection Rules, 2025, applicable commencement/enforcement timelines, and any other applicable education, state, contractual and procurement requirements.

Review:
- Who acts as data fiduciary and what role the startup plays.
- Appropriate and verifiable parental consent where required and any applicable educational-institution exemptions.
- Purpose limitation and data minimization.
- Parent/guardian verification and revocation.
- Privacy notices understandable to parents.
- Access, correction, grievance and other applicable rights.
- Retention, deletion, backups and lawful preservation.
- Breach detection, response and notification obligations.
- Vendor/subprocessor agreements.
- Data location, transfers and public-sector requirements.
- School authority and approval before onboarding.

Do not assume this document establishes legal compliance. Get legal review for the actual service and deployment date.

## 4. Data minimization
Do not collect Aadhaar, biometrics, continuous GPS, personal contacts unrelated to school operations or other sensitive fields by default. Use school-issued student IDs for the core account flow. Define a documented purpose and access policy for every additional data field.

## 5. Support access
- Platform operations must not automatically expose all student records.
- Emergency/support access should be purpose-limited, approved where required, time-bound and audited.
- Use redacted diagnostics where possible.
- Restrict production database access to authorized personnel.
- Review privileged access periodically.

## 6. Privacy-preserving notifications
- Avoid including detailed marks, sensitive circumstances or unnecessary child data in push previews.
- Link to the authenticated app for detailed information.
- Verify recipient relationships before sending.
- Prevent school/class announcements from being delivered to unrelated users.
- Provide notification preferences where appropriate without suppressing legally/operationally necessary messages.

## 7. Governance checklist
- Data inventory and purpose register
- Data-flow diagram and processor/vendor list
- Privacy notice and consent/verification workflow
- Retention and deletion schedule
- Data subject request workflow
- Incident response plan
- Access review process
- Backup and recovery policy
- Security testing plan
- Procurement and school authorization review
