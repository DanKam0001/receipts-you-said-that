import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { saveTokens, type TokenResponse } from "./token-store.js";

const clientId = process.env.TWITCH_CLIENT_ID;
if (!clientId) throw new Error("Set TWITCH_CLIENT_ID in .env");
const scopes = ["user:read:chat", "user:write:chat", "user:bot", "channel:read:stream_key"];
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

const start = await fetch("https://id.twitch.tv/oauth2/device", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, scopes: scopes.join(" ") })
});
if (!start.ok) throw new Error(`Twitch device authorization request failed (${start.status})`);
const device = await start.json() as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
const promptPath = resolve("data/auth_prompt.txt");
await mkdir("data", { recursive: true });
await writeFile(promptPath, `verification_url=${device.verification_uri}\nuser_code=${device.user_code}\nexpires_in=${device.expires_in}\n`, { encoding: "utf8" });
console.log(`Open on your phone: ${device.verification_uri}`);
console.log(`Enter this code: ${device.user_code}`);
console.log(`The same prompt is available at ${promptPath}. Waiting for Twitch approval.`);

let intervalMs = Math.max(1000, device.interval * 1000);
const deadline = Date.now() + device.expires_in * 1000;
while (Date.now() < deadline) {
  await sleep(intervalMs);
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scopes: scopes.join(" "), device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
  });
  const result = await response.json() as TokenResponse & { message?: string; status?: number; error?: string };
  if (response.ok) {
    await saveTokens(result);
    console.log("Twitch authorization completed. Tokens saved locally.");
    process.exit(0);
  }
  if (result.message === "authorization_pending") continue;
  if (result.message === "slow_down") { intervalMs += 5000; continue; }
  if (result.message === "access_denied") throw new Error("Twitch authorization was denied");
  if (result.message === "expired_token" || result.message === "invalid device code") throw new Error("Twitch device code expired; rerun npm run auth");
  throw new Error(`Twitch device token request failed (${response.status})`);
}
throw new Error("Twitch device code expired; rerun npm run auth");
