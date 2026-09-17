# ADR 0002: Authentication provider

## Status

Accepted for isolated implementation, 2026-09-17. This completes the imported framework template and complements [the architecture decision](0001-stack-and-boundaries.md).

## Context and decision

Orbit requires authenticated owners, explicit workspace/project membership, revocable sessions and server-enforced authorization without inventing password cryptography. Use Better Auth with its Prisma adapter and the four standard identity/session/account/verification tables.

Email/password sessions use HTTP-only, SameSite cookies, secure cookies for HTTPS, disabled cookie caching and bounded session lifetime. Public registration is disabled; first-owner setup requires the configured setup token. Workspace owners administer their workspace. Other users require explicit project membership with owner/editor/viewer permissions. API handlers derive scope from the current session and current database membership; request-supplied project or role values cannot grant access.

A separate limited authentication database role can access identity and membership/control tables, while the business role uses transaction-local project context and forced row-level security. Neither runtime role owns business tables or bypasses RLS. The trusted API/worker remains responsible for user authorization before scoped business transactions.

## Alternatives and consequences

A hosted identity service would add a separate availability and data-governance dependency. A custom password/session implementation would increase security maintenance without product value. Better Auth supplies maintained primitives while Orbit retains responsibility for setup protection, Origin checks, membership checks, secret management and upgrades.

MFA, external OAuth and passwordless login are not current capabilities and are not implied by the library choice. Production needs operator-managed unique secrets, HTTPS and account-recovery procedures. [Security review](../SECURITY_REVIEW.md), authenticated API tests and the Linux HTTPS acceptance record provide the current evidence; they do not authorize production use. [Owner mandates](0002-owner-mandates.md) govern business actions independently of login.
