import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export const TOKEN_PATH = ".tokens/twitch.json";
export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string[];
  token_type?: string;
}
export interface TokenResponse { access_token: string; refresh_token: string; expires_in: number; scope?: string[]; token_type?: string; }

export async function loadTokens(): Promise<StoredTokens> {
  return JSON.parse(await readFile(TOKEN_PATH, "utf8")) as StoredTokens;
}

export async function saveTokens(response: TokenResponse, existingScope?: string[]) {
  await mkdir(".tokens", { recursive: true });
  const tokens: StoredTokens = {
    access_token: response.access_token,
    refresh_token: response.refresh_token,
    expires_at: Date.now() + response.expires_in * 1000,
    scope: response.scope ?? existingScope ?? [],
    token_type: response.token_type ?? "bearer"
  };
  const temp = `${TOKEN_PATH}.tmp`;
  await writeFile(temp, JSON.stringify(tokens), { mode: 0o600 });
  await rename(temp, TOKEN_PATH);
  return tokens;
}

export async function refreshTokens(tokens: StoredTokens, clientId: string, clientSecret: string): Promise<StoredTokens> {
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: tokens.refresh_token })
  });
  if (!response.ok) throw new Error(`Twitch token refresh failed (${response.status}); rerun npm run auth if authorization expired`);
  const body = await response.json() as TokenResponse;
  return saveTokens(body, tokens.scope);
}

export async function validateToken(accessToken: string) {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${accessToken}` } });
  if (!response.ok) throw new Error(`Twitch token validation failed (${response.status})`);
  return await response.json() as { client_id: string; login: string; scopes: string[]; user_id: string; expires_in: number };
}
