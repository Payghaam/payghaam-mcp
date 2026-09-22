import { describe, expect, it } from "vitest";
import { generatePkce, getCredentialsPath } from "./auth.js";
import { createHash } from "node:crypto";

describe("OAuth PKCE and auth helpers", () => {
  it("generates RFC 7636 compliant PKCE parameters", () => {
    const { codeVerifier, codeChallenge, state } = generatePkce();

    expect(codeVerifier).toBeDefined();
    expect(codeChallenge).toBeDefined();
    expect(state).toBeDefined();

    // Verifier should be high entropy (at least 43 chars base64url)
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);

    // Challenge must equal SHA256(verifier) in base64url
    const computed = createHash("sha256").update(codeVerifier).digest("base64url");
    expect(codeChallenge).toEqual(computed);
  });

  it("determines credentials path under home directory", () => {
    const credsPath = getCredentialsPath();
    expect(credsPath).toContain(".payghaam");
    expect(credsPath).toMatch(/credentials\.json$/);
  });
});
