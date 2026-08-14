# Releasing

## One-time setup

1. **npm access token.** On npmjs.com, go to your account (or the `@payghaam`
   org, if it's set up as an npm org) → Access Tokens → Generate New Token →
   **Automation** type (works from CI without 2FA prompts).
2. If publishing under the `@payghaam` npm org for the first time, make sure
   the org exists on npmjs.com and your account has publish rights to it —
   `npm publish` will fail with a 402/403 otherwise.
3. **Add the repo secret** (Settings → Secrets and variables → Actions):
   - `NPM_TOKEN` — the automation token from step 1.

## Every release

1. Bump `version` in `package.json`.
2. Commit, push to `main`.
3. `git tag v0.1.1 && git push --tags` — this triggers
   `.github/workflows/publish.yml`. The tag must exactly match
   `v<package.json version>`, or the workflow fails before publishing (see
   the sanity-check step in publish.yml).
4. Publish is near-instant — check `npm view @payghaam/mcp-server versions`
   or the npmjs.com package page.
