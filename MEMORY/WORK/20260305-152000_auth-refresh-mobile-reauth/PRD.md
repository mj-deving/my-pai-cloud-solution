---
task: "Fix auth error handling + design mobile re-auth via Telegram"
slug: "20260305-152000_auth-refresh-mobile-reauth"
effort: Extended
phase: complete
progress: 16/16
mode: algorithm
started: 2026-03-05T15:20:00+01:00
updated: 2026-03-05T15:20:00+01:00
---

## Context

OAuth token on VPS expired. Bridge shows "Claude crashed with no output" because the authentication_error comes through stream-json events (not stderr), so `friendlyError()` pattern `/exited with code \d+:\s*$/` matches the empty-stderr case instead of surfacing the real error.

User wants: (1) fix auth error surfacing, (2) re-auth now, (3) design a `/reauth` Telegram command for mobile re-auth from phone.

OAuth flow details (from CLI source):
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Authorize: `https://claude.ai/oauth/authorize`
- Token: `https://platform.claude.com/v1/oauth/token`
- Manual redirect: `https://platform.claude.com/oauth/code/callback` (shows code to user)
- Scopes: `user:inference user:mcp_servers user:profile user:sessions:claude_code`
- PKCE: S256 code_challenge_method
- Credentials file: `~/.claude/.credentials.json`

Design: Bridge generates OAuth URL with PKCE, sends to Telegram. User opens on phone, authenticates, gets auth code from callback page, pastes code back to Telegram. Bridge exchanges code for tokens, writes credentials.

### Risks
- PKCE code_verifier must be stored between URL generation and code exchange
- OAuth redirect_uri must exactly match what's registered (manual redirect URL)
- Token exchange must produce same credential format Claude CLI expects
- Auth code has short TTL — user must be quick

## Criteria

- [x] ISC-1: Bridge detects "authentication_error" in stream-json result events
- [x] ISC-2: Bridge detects "OAuth token has expired" in stream-json result events
- [x] ISC-3: friendlyError() returns actionable auth-expired message with /reauth hint
- [x] ISC-4: /reauth command registered in Grammy bot handler
- [x] ISC-5: /reauth generates PKCE code_verifier and code_challenge (S256)
- [x] ISC-6: /reauth builds OAuth authorize URL with correct client_id, redirect_uri, scopes, PKCE
- [x] ISC-7: /reauth sends clickable OAuth URL to user via Telegram
- [x] ISC-8: /reauth stores PKCE code_verifier in memory for code exchange
- [x] ISC-9: Next message after /reauth treated as auth code input
- [x] ISC-10: Bridge exchanges auth code + code_verifier at token endpoint
- [x] ISC-11: Bridge writes new tokens to ~/.claude/.credentials.json in correct format
- [x] ISC-12: Bridge confirms successful re-auth via Telegram message
- [x] ISC-13: /reauth flow times out after 5 minutes if no code received
- [x] ISC-14: /reauth handles invalid/expired auth code with clear error
- [x] ISC-15: VPS re-authenticated and Claude CLI working after implementation
- [x] ISC-16: Auth error in stream-json no longer shows "crashed with no output"

## Decisions

## Verification
