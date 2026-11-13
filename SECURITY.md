# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in SignuDoc, please report it privately. **Do not put the details in a public GitHub issue, discussion or pull request.**

Send your report through GitHub's private vulnerability reporting: open the [Report a vulnerability](https://github.com/NYLLON-SOFTWARE/SignuDoc/security/advisories/new) form, which is also on this repository's security advisories page. The report stays between you and the repository's maintainers. Include:

- A description of the vulnerability.
- Steps to reproduce or a proof of concept.
- The potential impact as you understand it.

If that form is not available to you, open an issue that asks the maintainers for a private way to reach them, and leave every detail of the vulnerability out of it.

The project has no email address for reports. Each organization that runs SignuDoc gives its own install a support address, and that address reaches the organization, not the people who maintain this code. A problem with one particular site, such as its settings or the documents it holds, belongs with the organization that runs it.

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
