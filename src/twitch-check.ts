import "dotenv/config";
import { WebSocket } from "ws";
import { loadTokens, refreshTokens, validateToken } from "./token-store.js";

const REQUIRED_SCOPES = ["user:read:chat", "user:write:chat", "user:bot", "channel:read:stream_key"];
const clientId = process.env.TWITCH_CLIENT_ID, clientSecret = process.env.TWITCH_CLIENT_SECRET, channel = process.env.TWITCH_CHANNEL;
if (!clientId || !clientSecret || !channel) throw new Error("Set Twitch client ID, client secret, and channel in .env");
const sendIndex = process.argv.indexOf("--send");
const sendText = sendIndex >= 0 ? process.argv[sendIndex + 1] : undefined;
if (sendIndex >= 0 && (!sendText || sendText.startsWith("--") || sendText.length > 500)) throw new Error('--send requires one message of 1–500 characters, e.g. npm run twitch:check -- --send "Test"');

let tokens = await loadTokens();
if (tokens.expires_at <= Date.now() + 60_000) tokens = await refreshTokens(tokens, clientId, clientSecret);
let identity;
try { identity = await validateToken(tokens.access_token); }
catch { tokens = await refreshTokens(tokens, clientId, clientSecret); identity = await validateToken(tokens.access_token); }
console.log(`Token validation: passed (login ${identity.login})`);
console.log(`Scopes: ${identity.scopes.join(", ")}`);
const missing = REQUIRED_SCOPES.filter(scope => !identity.scopes.includes(scope));
if (missing.length) throw new Error(`Required scopes missing: ${missing.join(", ")}; rerun npm run auth`);
console.log("Required scopes: passed");

const helix = async (path: string, init: RequestInit = {}) => {
  const used = tokens.access_token;
  let response = await fetch(`https://api.twitch.tv/helix${path}`, { ...init, headers: { Authorization: `Bearer ${used}`, "Client-Id": clientId, "Content-Type": "application/json", ...init.headers } });
  if (response.status === 401) {
    if (tokens.access_token === used) tokens = await refreshTokens(tokens, clientId, clientSecret);
    response = await fetch(`https://api.twitch.tv/helix${path}`, { ...init, headers: { Authorization: `Bearer ${tokens.access_token}`, "Client-Id": clientId, "Content-Type": "application/json", ...init.headers } });
  }
  if (!response.ok) throw new Error(`Twitch API request failed (${response.status})`);
  return response;
};
const channelResponse = await helix(`/users?login=${encodeURIComponent(channel)}`);
const channelData = await channelResponse.json() as { data: Array<{ id: string; login: string }> };
const broadcaster = channelData.data[0];
if (!broadcaster) throw new Error("TWITCH_CHANNEL did not resolve to a Twitch account");
console.log(`Channel lookup: passed (${broadcaster.login})`);

let eventSubPassed = false;
try {
const eventSubResult = await new Promise<{ status: number; message: string }>((resolve, reject) => {
  const socket = new WebSocket("wss://eventsub.wss.twitch.tv/ws");
  const timer = setTimeout(() => { socket.close(); reject(new Error("EventSub welcome timed out")); }, 12_000);
  socket.on("error", err => { clearTimeout(timer); reject(err); });
  socket.on("message", raw => {
    void (async () => {
      const message = JSON.parse(String(raw));
      if (message.metadata?.message_type === "session_welcome") {
        clearTimeout(timer);
        try {
          const response = await helix("/eventsub/subscriptions", { method: "POST", body: JSON.stringify({
            type: "channel.chat.message", version: "1",
            condition: { broadcaster_user_id: broadcaster.id, user_id: identity.user_id },
            transport: { method: "websocket", session_id: message.payload.session.id }
          }) });
          const status = response.status; socket.close(); resolve({ status, message: "subscription accepted" });
        } catch (error) { socket.close(); reject(error); }
      } else if (message.metadata?.message_type === "revocation") {
        socket.close(); reject(new Error("EventSub session was revoked"));
      }
    })().catch(reject);
  });
});
console.log(`EventSub channel.chat.message: passed (HTTP ${eventSubResult.status}, ${eventSubResult.message})`);
eventSubPassed = true;
} catch (error) {
  console.log(`EventSub channel.chat.message: failed (${(error as Error).message})`);
  process.exitCode = 1;
}

if (sendText !== undefined) {
  if (!eventSubPassed) throw new Error("Test chat message not sent because the EventSub check did not pass");
  await helix("/chat/messages", { method: "POST", body: JSON.stringify({ broadcaster_id: broadcaster.id, sender_id: identity.user_id, message: sendText }) });
  console.log("Test chat message: sent");
} else console.log("Test chat message: skipped (pass --send \"text\" to send one)");
