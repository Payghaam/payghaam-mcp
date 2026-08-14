# Releasing

Publishing uses npm's [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC) — no `NPM_TOKEN` secret, nothing to rotate or leak. npm tightened
restrictions on long-lived automation tokens in 2026, and this is the
replacement they're pushing everyone toward.

## One-time setup

1. **First publish must happen manually**, since npm's trusted-publisher
   config lives on the package's *existing* settings page — there's no
   "reserve this name for CI" step for a package that's never been published.
   From your own machine, logged in (`npm login`, needs 2FA):
   ```
   npm install
   npm run build
   npm publish --access public
   ```
   If publishing under the `@payghaam` npm org for the first time, make sure
   the org exists on npmjs.com and your account has publish rights to it —
   this will fail with a 402/403 otherwise.
2. **Configure the trusted publisher.** npmjs.com → your package
   (`@payghaam/mcp-server`) → Settings → Trusted Publisher → GitHub Actions:
   - Organization: `Payghaam`
   - Repository: `payghaam-mcp`
   - Workflow filename: `publish.yml` (just the filename, not the path)
   - Allowed actions: `npm publish`
3. (Recommended) Once trusted publishing is verified working, go to
   Settings → Publishing access → **Require two-factor authentication and
   disallow tokens**, then revoke any `NPM_TOKEN`-style automation tokens you
   created for this package. Trusted publishing keeps working — only
   classic token auth gets locked out.

## Every release (after the first)

1. Bump `version` in `package.json`.
2. Commit, push to `main`.
3. `git tag v0.1.1 && git push --tags` — this triggers
   `.github/workflows/publish.yml`. The tag must exactly match
   `v<package.json version>`, or the workflow fails before publishing (see
   the sanity-check step in publish.yml).
4. Publish is near-instant — check `npm view @payghaam/mcp-server versions`
   or the npmjs.com package page. A provenance badge should appear
   automatically (public repo + public package + OIDC = npm generates it for
   you, no extra flag needed).
