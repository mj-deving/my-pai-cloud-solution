// auth.ts — OAuth re-authentication flow for Claude CLI
// Generates PKCE OAuth URLs, exchanges auth codes for tokens, writes credentials

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "user:inference user:mcp_servers user:profile user:sessions:claude_code";

interface PendingAuth {
  codeVerifier: string;
  state: string;
  createdAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface CredentialsFile {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
}

export class AuthManager {
  private pending: PendingAuth | null = null;
  private readonly credentialsPath: string;
  private readonly timeoutMs: number;

  constructor(homeDir?: string, timeoutMs = 300_000) {
    const home = homeDir || process.env.HOME || "/home/isidore_cloud";
    this.credentialsPath = join(home, ".claude", ".credentials.json");
    this.timeoutMs = timeoutMs;
  }

  /** Check if we're currently waiting for an auth code. */
  isAwaitingCode(): boolean {
    if (!this.pending) return false;
    if (Date.now() - this.pending.createdAt > this.timeoutMs) {
      this.pending = null;
      return false;
    }
    return true;
  }

  /** Generate PKCE values and return the OAuth authorization URL. */
  startAuth(): string {
    // Generate PKCE code_verifier (43-128 chars, URL-safe)
    const codeVerifier = randomBytes(32)
      .toString("base64url")
      .slice(0, 64);

    // Generate code_challenge = BASE64URL(SHA256(code_verifier))
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    // state parameter is required by claude.ai OAuth — random value for CSRF protection
    const state = randomBytes(16).toString("hex");

    this.pending = {
      codeVerifier,
      state,
      createdAt: Date.now(),
    };

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Cancel any pending auth flow. */
  cancel(): void {
    this.pending = null;
  }

  /** Exchange the authorization code for tokens and write credentials. */
  async exchangeCode(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.pending) {
      return { ok: false, error: "No pending auth flow. Run /reauth first." };
    }

    if (Date.now() - this.pending.createdAt > this.timeoutMs) {
      this.pending = null;
      return { ok: false, error: "Auth flow timed out (5 minutes). Run /reauth again." };
    }

    const { codeVerifier, state } = this.pending;
    // Strip #state fragment if user pasted the full callback value (code#state)
    const cleanCode = code.trim().split("#")[0] ?? code.trim();

    try {
      const resp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLAUDE_CLIENT_ID,
          code: cleanCode,
          redirect_uri: REDIRECT_URI,
          code_verifier: codeVerifier,
          state,
        }).toString(),
      });

      if (!resp.ok) {
        const body = await resp.text();
        this.pending = null;
        return { ok: false, error: `Token exchange failed (${resp.status}): ${body.slice(0, 200)}` };
      }

      const tokens = await resp.json() as TokenResponse;

      // Read existing credentials to preserve fields we don't control
      let existing: CredentialsFile | null = null;
      try {
        const raw = await readFile(this.credentialsPath, "utf-8");
        existing = JSON.parse(raw);
      } catch {
        // No existing file — will create fresh
      }

      const credentials: CredentialsFile = {
        claudeAiOauth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          scopes: (tokens.scope || SCOPES).split(" "),
          subscriptionType: existing?.claudeAiOauth?.subscriptionType || "max",
          rateLimitTier: existing?.claudeAiOauth?.rateLimitTier || "default_claude_max_5x",
        },
      };

      await writeFile(this.credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
      this.pending = null;

      console.log("[auth] OAuth tokens refreshed successfully");
      return { ok: true };

    } catch (err) {
      this.pending = null;
      return { ok: false, error: `Token exchange error: ${err}` };
    }
  }

  /** Check current auth status — returns expiry info. */
  async checkStatus(): Promise<{ valid: boolean; expiresAt?: Date; error?: string }> {
    try {
      const raw = await readFile(this.credentialsPath, "utf-8");
      const creds = JSON.parse(raw) as CredentialsFile;
      const expiresAt = new Date(creds.claudeAiOauth.expiresAt);
      return {
        valid: expiresAt.getTime() > Date.now(),
        expiresAt,
      };
    } catch (err) {
      return { valid: false, error: `Cannot read credentials: ${err}` };
    }
  }
}
