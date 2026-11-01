import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { oauthUrl, saveTokens } from "./twitch.js";

const { TWITCH_CLIENT_ID: clientId, TWITCH_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) throw new Error("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env");
const redirectUri = process.env.RECEIPTS_REDIRECT_URI ?? "http://localhost:3000";
const redirect = new URL(redirectUri);
const state = randomBytes(24).toString("hex");
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirect);
  if (url.pathname !== "/") { res.writeHead(404).end(); return; }
  const got = Buffer.from(url.searchParams.get("state") ?? ""); const expected = Buffer.from(state);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) { res.writeHead(400).end("OAuth state mismatch"); return; }
  const code = url.searchParams.get("code");
  if (!code) { res.writeHead(400).end("No authorization code received"); return; }
  const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, code, grant_type: "authorization_code", redirect_uri: redirectUri }) });
  if (!response.ok) { res.writeHead(502).end(`Twitch token exchange failed (${response.status})`); return; }
  const tokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  await saveTokens(tokens); res.writeHead(200, { "content-type": "text/plain" }).end("Receipts is authorized. You can close this page.");
  console.log("OAuth approval stored locally. Token values were not displayed."); server.close();
});
server.listen(Number(redirect.port || 80), redirect.hostname, () => {
  console.log(`Approve Receipts in a browser: ${oauthUrl(state, clientId!)}`);
});
