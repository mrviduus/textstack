# Security Policy

## Supported Versions

Only the `main` branch and the latest GitHub Release receive security updates. Older tags are not patched.

| Version           | Supported          |
| ----------------- | ------------------ |
| `main` (HEAD)     | :white_check_mark: |
| Latest release    | :white_check_mark: |
| Older releases    | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

Use one of:

1. **Preferred — GitHub private vulnerability report:**
   <https://github.com/mrviduus/textstack/security/advisories/new>
2. **Email:** `vasyl.vdov@gmail.com` with subject `[textstack security]`.

Include, when possible:

- Affected component (web, mobile, API, worker, infra).
- Version / commit SHA.
- Reproduction steps or PoC.
- Impact assessment.
- Your disclosure timeline preferences.

### What to expect

- **Acknowledgement:** within 72 hours.
- **Initial triage:** within 7 days.
- **Fix or mitigation:** target 30 days for high/critical, best-effort otherwise.
- **Coordinated disclosure:** we'll agree on a public-disclosure date once a fix is in place.
- **Credit:** with your permission, in the release notes / advisory.

## Out of Scope

- Self-XSS that requires social engineering of the victim.
- Reports based solely on outdated dependency scanners without a working PoC.
- Denial of service via volumetric/network attack on hosted instance.
- Issues in third-party services we do not control (Cloudflare, OpenAI, Resend, EAS, etc.).
- Missing security headers without demonstrated impact.
- Findings on local-development-only configurations (`.env.example`, dev keys).

## Safe Harbor

Good-faith research that follows this policy will not result in legal action from us, provided you:

- Avoid privacy violations, data destruction, and service disruption.
- Do not access user data beyond the minimum required to demonstrate the issue.
- Give us a reasonable time to remediate before public disclosure.

Thank you for helping keep TextStack and its users safe.
