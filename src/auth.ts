import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";

export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  projectId?: string;
  apiUrl?: string;
}

export function getCredentialsDir(): string {
  return join(homedir(), ".payghaam");
}

export function getCredentialsPath(): string {
  return join(getCredentialsDir(), "credentials.json");
}

export function saveCredentials(creds: StoredCredentials): void {
  const dir = getCredentialsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(getCredentialsPath(), JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
}

export function clearCredentials(): void {
  const path = getCredentialsPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

export async function loadCredentials(apiUrl: string): Promise<StoredCredentials | null> {
  const path = getCredentialsPath();
  if (!existsSync(path)) return null;

  let creds: StoredCredentials;
  try {
    const raw = readFileSync(path, "utf-8");
    creds = JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }

  // If token is expiring within 60s, refresh if refresh_token is present
  const now = Date.now();
  if (creds.expiresAt && creds.expiresAt - now < 60_000 && creds.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(apiUrl, creds.refreshToken);
      if (refreshed) {
        creds.accessToken = refreshed.access_token;
        if (refreshed.refresh_token) {
          creds.refreshToken = refreshed.refresh_token;
        }
        if (refreshed.expires_in) {
          creds.expiresAt = Date.now() + refreshed.expires_in * 1000;
        }
        saveCredentials(creds);
      } else {
        clearCredentials();
        return null;
      }
    } catch {
      // If refresh fails, keep current token if not strictly expired yet
      if (creds.expiresAt && creds.expiresAt <= now) {
        return null;
      }
    }
  }

  return creds;
}

async function refreshAccessToken(
  apiUrl: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number } | null> {
  const normalized = apiUrl.replace(/\/+$/, "");
  const res = await fetch(`${normalized}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: "payghaam-cli",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) return null;
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
}

export function generatePkce(): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  return { codeVerifier, codeChallenge, state };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd = "";
  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {
    // best-effort
  });
}

export interface LoginOptions {
  apiUrl?: string;
  dashboardUrl?: string;
}

export async function runLoginFlow(options: LoginOptions = {}): Promise<void> {
  const apiUrl = (options.apiUrl || process.env.PAYGHAAM_API_URL || "https://api.payghaam.com/api").replace(
    /\/+$/,
    "",
  );

  // Default dashboard URL: infer localhost:3000 if apiUrl is localhost, else https://app.payghaam.com
  let defaultDashboard = "https://app.payghaam.com";
  if (apiUrl.includes("localhost") || apiUrl.includes("127.0.0.1")) {
    defaultDashboard = "http://localhost:3000";
  }
  const dashboardUrl = (options.dashboardUrl || process.env.PAYGHAAM_DASHBOARD_URL || defaultDashboard).replace(
    /\/+$/,
    "",
  );

  const { codeVerifier, codeChallenge, state } = generatePkce();

  return new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (!req.url || !req.url.startsWith("/callback")) {
          res.writeHead(404);
          res.end();
          return;
        }

        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const callbackUrl = new URL(req.url, `http://127.0.0.1:${port}`);
        const code = callbackUrl.searchParams.get("code");
        const returnedState = callbackUrl.searchParams.get("state");
        const error = callbackUrl.searchParams.get("error");
        const errorDescription = callbackUrl.searchParams.get("error_description");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<html><body style="font-family: system-ui, sans-serif; padding: 40px; text-align: center;">` +
              `<h2 style="color: #ef4444;">Authorization Denied</h2>` +
              `<p>${errorDescription || error}</p>` +
              `<p>You can close this tab and return to your terminal.</p>` +
              `</body></html>`,
          );
          server.close();
          reject(new Error(`OAuth authorization error: ${errorDescription || error}`));
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body><h2>State mismatch</h2><p>Security validation failed.</p></body></html>`);
          server.close();
          reject(new Error("State verification failed: potential CSRF detected."));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body><h2>Missing code</h2><p>No authorization code received.</p></body></html>`);
          server.close();
          reject(new Error("No authorization code provided in callback."));
          return;
        }

        // Exchange authorization code for tokens
        const tokenRes = await fetch(`${apiUrl}/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: "payghaam-cli",
            code,
            redirect_uri: `http://127.0.0.1:${port}/callback`,
            code_verifier: codeVerifier,
          }),
        });

        if (!tokenRes.ok) {
          const body = await tokenRes.text();
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<html><body style="font-family: system-ui, sans-serif; padding: 40px; text-align: center;">` +
              `<h2 style="color: #ef4444;">Token Exchange Failed</h2>` +
              `<p>${body}</p>` +
              `</body></html>`,
          );
          server.close();
          reject(new Error(`Failed to exchange authorization code for token: ${body}`));
          return;
        }

        const tokenData = (await tokenRes.json()) as {
          access_token: string;
          token_type: string;
          expires_in: number;
          refresh_token?: string;
          project_id: string;
        };

        // Save credentials locally
        saveCredentials({
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: Date.now() + tokenData.expires_in * 1000,
          projectId: tokenData.project_id,
          apiUrl,
        });

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family: system-ui, sans-serif; padding: 40px; text-align: center; background: #0f172a; color: #f8fafc;">` +
            `<div style="max-width: 440px; margin: 0 auto; background: #1e293b; padding: 32px; border-radius: 12px; border: 1px solid #334155;">` +
            `<h2 style="color: #10b981; margin-top: 0;">✓ Connected to Payghaam!</h2>` +
            `<p style="color: #94a3b8; font-size: 14px;">Your MCP client is now authenticated for project <code style="color: #38bdf8; background: #0f172a; padding: 2px 6px; border-radius: 4px;">${tokenData.project_id}</code>.</p>` +
            `<p style="color: #64748b; font-size: 13px; margin-top: 24px;">You can safely close this browser tab.</p>` +
            `</div>` +
            `</body></html>`,
        );

        server.close();
        process.stdout.write(
          `\n✓ Successfully authenticated with Payghaam!\n` +
            `Project: ${tokenData.project_id}\n` +
            `Credentials saved to: ${getCredentialsPath()}\n\n` +
            `You can now use Claude Desktop or Cursor IDE with zero manual configuration.\n`,
        );
        resolve();
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      const authUrl =
        `${dashboardUrl}/oauth/authorize` +
        `?client_id=payghaam-cli` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&code_challenge_method=S256` +
        `&state=${encodeURIComponent(state)}`;

      process.stdout.write(
        `Opening your browser to authorize Payghaam MCP...\n` +
          `If the browser does not open automatically, visit this URL:\n\n` +
          `  ${authUrl}\n\n` +
          `Waiting for authorization...\n`,
      );

      openBrowser(authUrl);
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

export async function runLogoutFlow(options: LoginOptions = {}): Promise<void> {
  const apiUrl = (options.apiUrl || process.env.PAYGHAAM_API_URL || "https://api.payghaam.com/api").replace(
    /\/+$/,
    "",
  );
  const path = getCredentialsPath();
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const creds = JSON.parse(raw) as StoredCredentials;
      if (creds.refreshToken) {
        await fetch(`${apiUrl}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: creds.refreshToken, token_type_hint: "refresh_token" }),
        }).catch(() => undefined);
      }
    } catch {
      // ignore
    }
    clearCredentials();
  }
  process.stdout.write("✓ Logged out. Stored credentials removed.\n");
}
