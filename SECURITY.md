# Security Policy

## Reporting a vulnerability

Do not post vulnerability details, credentials, private CAD files, or exploit payloads in public issues or pull requests.

Check the repository's [Security tab](https://github.com/esaueng/OpenZCAD/security). If **Report a vulnerability** is available, use it to submit a private report. GitHub private vulnerability reporting is currently disabled. Until a private channel is available, open a minimal issue titled **Private security contact requested**, with no affected endpoint, reproduction steps, attachments, or sensitive details. Wait for a maintainer to provide a private channel before sharing the report.

In the private report, include the affected commit or version, prerequisites, a minimal reproduction using synthetic data, expected and observed behavior, and impact. Never send live credentials. This policy does not promise a response deadline or a bounty.

## Scope and security boundaries

OpenZCAD includes a browser CAD workspace, geometry workers, an optional desktop shell, and Cloudflare services for identity, cloud storage, collaboration, and AI orchestration. Imported CAD files, project documents, network requests, collaboration messages, and AI output must be treated as untrusted input.

Security properties that must hold include:

- Authentication and project authorization protect cloud documents, settings, and collaboration access.
- Provider credentials and session secrets are not exposed in public responses, project documents, logs, or committed configuration.
- Development authentication cannot grant access in guarded deployments.
- AI proposals remain constrained and require the documented user-controlled application flow.
- Untrusted files and requests are validated and bounded before expensive processing or persistent mutation.

Reports should explain a reachable failure and its impact, such as unauthorized access, secret disclosure, code execution, or resource exhaustion. No vulnerability classes are excluded by this policy. These are required properties, not a claim that every implementation has been independently verified.

Include the affected revision even if it is older than `main`; a supported-version or backport schedule has not been established here. Test only systems and data you are authorized to use, preferably a local instance with synthetic data.
