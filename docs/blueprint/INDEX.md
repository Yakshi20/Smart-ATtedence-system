# Smart School Management System — Project Blueprint

**Product:** Multi-school Smart School Management System  
**Initial market:** Karnataka, India  
**School types:** Government and private  
**Grades:** Classes 1–7  
**Operator:** Startup / SaaS provider  
**Platforms:** Android/iOS mobile app + web administration portal  
**Languages:** English, Kannada, and extensible Indian-language support  
**Assessment:** Configurable per school / academic year

## How to use this pack with Claude

1. Upload this entire ZIP to Claude, or upload the Markdown files as a project knowledge base.
2. Start with `00_MASTER_BRIEF.md`.
3. Ask Claude to review the files for contradictions and produce an implementation backlog.
4. Build in vertical slices; do not generate the entire production codebase in one response.
5. Treat all legal and security items as requirements to verify, not as proof of compliance.

## Document map

- `00_MASTER_BRIEF.md` — product vision, scope, assumptions, instructions for AI coding
- `01_REQUIREMENTS.md` — functional and non-functional requirements
- `02_ROLES_PERMISSIONS.md` — roles, permission matrix, tenancy and authorization rules
- `03_SCREENS_AND_UX.md` — screen inventory and primary user journeys
- `04_ARCHITECTURE.md` — technical architecture and repository structure
- `05_DATABASE_SCHEMA.md` — logical schema, constraints, indexes and data lifecycle
- `06_API_SPECIFICATION.md` — REST API conventions and endpoint inventory
- `07_SECURITY_PRIVACY_COMPLIANCE.md` — security, child privacy, governance and compliance checklist
- `08_WORKFLOWS_AND_ACCEPTANCE.md` — core workflows and release acceptance tests
- `09_IMPLEMENTATION_ROADMAP.md` — phases, milestones, testing and rollout
- `10_CLAUDE_BUILD_PROMPT.md` — copy-paste prompt for Claude

## Core non-negotiable principles

1. A parent can access only verified linked children.
2. A student can access only their own personal academic records.
3. A teacher can access only assigned classes and subjects.
4. School staff are scoped to their school.
5. District users are scoped to their authorized district and purpose.
6. Platform operations do not imply unrestricted access to children's academic records.
7. All authorization is enforced server-side on every request.
8. Published marks and attendance are changed only through an audited correction workflow.
9. Never hardcode one grading system for all schools.
10. Pilot and rollout happen in controlled batches even if the architecture supports district-wide scale.
