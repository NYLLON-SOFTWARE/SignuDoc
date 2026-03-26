# Contributing

Issues and pull requests are welcome.

## Getting started

1. Fork the repository and clone your fork.
2. Install dependencies: `npm install`
3. Copy the environment file: `cp .env.example .env`
4. Start the dev server: `npm run dev`

See the [README](./README.md) for full setup details.

## Development workflow

Before submitting a pull request, make sure everything passes:

```bash
npm run typecheck
npm run lint
npm run format:check
```

If your change touches auth, email, storage, or production-only configuration, verify the related env-backed flow against the setup notes in [README.md](./README.md).

If your change touches Better Auth tables or plugins, run `npm run auth:generate` and update the committed migration as needed.

## Project style

- Small, focused components.
- Explicit server-side logic over implicit magic.
- Schema-validated inputs using Zod.
- Keep dependencies minimal. Don't add a library for something a few lines of code can handle.

## Pull requests

- Keep PRs focused on a single change.
- Include a clear description of what the PR does and why.
- If the PR fixes an issue, reference it in the description.

## Reporting bugs

Open a GitHub issue with steps to reproduce, expected behavior, and actual behavior. Include your Node.js version and OS if relevant.

## Security vulnerabilities

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](./SECURITY.md) for how to report them.
