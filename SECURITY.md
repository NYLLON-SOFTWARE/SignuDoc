# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in SignuDoc, please report it privately. **Do not open a public GitHub issue.**

Email your report to **support@signudoc.app** with:

- A description of the vulnerability.
- Steps to reproduce or a proof of concept.
- The potential impact as you understand it.

If GitHub private vulnerability reporting is enabled for this repository, you may use that as well.

We will acknowledge your report within 7 days and aim to provide a fix or mitigation plan within 30 days, depending on severity and complexity.

## Scope

This policy covers the SignuDoc application code in this repository, including:

- Authentication and session handling
- Signing token and download token generation and verification
- Document storage and access controls
- API route authorization and rate limiting
- Email delivery logic

## Out of scope

- Vulnerabilities in third-party dependencies (report those to the upstream project, though we appreciate a heads-up)
- Issues in your own self-hosted deployment configuration (infrastructure, DNS, TLS, etc.)
- Social engineering attacks

## Supported versions

Security fixes are applied to the latest release only.

## Recognition

We appreciate responsible disclosure. If you report a valid vulnerability, we are happy to credit you in the fix commit or release notes unless you prefer to remain anonymous.
