# Security

This is a local release candidate under verification. See docs/SECURITY_REVIEW.md and docs/RELEASE_READINESS.md for current gates. Do not deploy from an unverified checkpoint.

Report vulnerabilities privately to the repository owner through a private security advisory once a repository is published. No public security contact address has been authorized yet; do not include exploit details in a public issue. Never submit credentials, customer data or full private documents.

Trust boundaries: imported content cannot issue tool commands. Web has no database credentials. API authenticates and scopes every project access. PostgreSQL business roles use FORCE RLS and transaction-local context; provider credentials are encrypted with an independently managed key. Actions are versioned, hash-bound and rechecked at handoff. Token/account verification and source rights are independent from a successful request.
