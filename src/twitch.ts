import { EventEmitter } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { WebSocket } from "ws";
import type { ChatMessage } from "./model.js";

export interface ChatSource extends EventEmitter { start(): Promise<void>; send(text: string, replyId?: string): Promise<void>; stop(): void; readonly simulated: boolean; }
export class SimulatedChatSource extends EventEmitter implements ChatSource {
  readonly simulated = true;
  async start() { /* POST /api/simulate injects the same normalized message shape. */ }
  inject(message: ChatMessage) { this.emit("message", message); }
  async send(text: string) { console.log(`[simulated chat reply] ${text}`); }
  stop() {}
}

interface TokenFile { access_token: string; refresh_token: string; expires_at: number; }
const TOKEN_PATH = ".tokens/twitch.json";
const scopes = ["user:read:chat", "user:write:chat", "user:bot"];

export class TwitchChatSource extends EventEmitter implements ChatSource {
  readonly simulated = false;
  private socket?: WebSocket;
  private token!: TokenFile;
  private broadcasterId!: string;
  private userId!: string;
  private stopped = false;
  private reconnecting = false;
  private seen = new Set<string>();
  constructor(private readonly cfg: { clientId: string; clientSecret: string; channel: string }) { super(); }
  async start() {
    this.token = JSON.parse(await readFile(TOKEN_PATH, "utf8")) as TokenFile;
    await this.refreshIfNeeded();
    const validation = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${this.token.access_token}` } });
    const identity = await validation.json() as { user_id: string };
    this.userId = identity.user_id;
    const userResp = await this.helix(`/users?login=${encodeURIComponent(this.cfg.channel)}`);
    const users = await userResp.json() as { data: Array<{ id: string }> };
    if (!users.data[0]) throw new Error("TWITCH_CHANNEL did not resolve to a Twitch account");
    this.broadcasterId = users.data[0].id;
    this.connect("wss://eventsub.wss.twitch.tv/ws");
  }
  private async refreshIfNeeded() {
    if (this.token.expires_at > Date.now() + 60_000) return;
    const res = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: "refresh_token", refresh_token: this.token.refresh_token }) });
    if (!res.ok) throw new Error(`Twitch token refresh failed (${res.status})`);
    const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    this.token = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 };
    await writeFile(TOKEN_PATH, JSON.stringify(this.token), { mode: 0o600 });
  }
  private async helix(path: string, init: RequestInit = {}) {
    await this.refreshIfNeeded();
    const res = await fetch(`https://api.twitch.tv/helix${path}`, { ...init, headers: { Authorization: `Bearer ${this.token.access_token}`, "Client-Id": this.cfg.clientId, "Content-Type": "application/json", ...init.headers } });
    if (!res.ok) throw new Error(`Twitch API request failed (${res.status}): ${path.split("?")[0]}`);
    return res;
  }
  private connect(url: string) {
    const socket = new WebSocket(url); this.socket = socket;
    socket.on("message", raw => { try { void this.handle(JSON.parse(String(raw))).catch(err => this.emit("error", err)); } catch (err) { this.emit("error", err); } });
    socket.on("error", err => this.emit("error", err));
    socket.on("close", () => { if (!this.stopped && !this.reconnecting && this.socket === socket) setTimeout(() => this.connect("wss://eventsub.wss.twitch.tv/ws"), 2000); });
  }
  private async handle(msg: any) {
    const type = msg.metadata?.message_type;
    if (type === "session_welcome") {
      const sessionId = msg.payload.session.id;
      await this.helix("/eventsub/subscriptions", { method: "POST", body: JSON.stringify({ type: "channel.chat.message", version: "1",
        condition: { broadcaster_user_id: this.broadcasterId, user_id: this.userId }, transport: { method: "websocket", session_id: sessionId } }) });
      this.emit("ready");
    } else if (type === "session_reconnect") {
      this.reconnecting = true;
      let adopted = false;
      const next = new WebSocket(msg.payload.session.reconnect_url);
      next.on("message", raw => {
        const nextMsg = JSON.parse(String(raw));
        if (nextMsg.metadata?.message_type === "session_welcome") { const previous = this.socket; this.socket = next; adopted = true; this.reconnecting = false; previous?.close(); }
        else void this.handle(nextMsg);
      });
      next.on("error", err => this.emit("error", err));
      next.on("close", () => { if (!adopted && !this.stopped) { this.reconnecting = false; this.connect("wss://eventsub.wss.twitch.tv/ws"); } });
    } else if (type === "notification" && msg.payload?.subscription?.type === "channel.chat.message") {
      const id = msg.metadata.message_id;
      if (this.seen.has(id)) return; this.seen.add(id);
      if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
      const e = msg.payload.event;
      const badges = (e.badges ?? []).map((b: any) => b.set_id);
      this.emit("message", { userId: e.chatter_user_id, username: e.chatter_user_name, text: e.message.text,
        isMod: badges.includes("moderator"), isBroadcaster: e.chatter_user_id === this.broadcasterId } satisfies ChatMessage);
    }
  }
  async send(text: string, replyId?: string) {
    await this.helix("/chat/messages", { method: "POST", body: JSON.stringify({ broadcaster_id: this.broadcasterId, sender_id: this.userId, message: text, ...(replyId ? { reply_parent_message_id: replyId } : {}) }) });
  }
  stop() { this.stopped = true; this.socket?.close(); }
}

export function oauthUrl(state: string, clientId: string) {
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: process.env.RECEIPTS_REDIRECT_URI ?? "http://localhost:3000", response_type: "code", scope: scopes.join(" "), state }).toString();
  return url.toString();
}
export async function saveTokens(data: { access_token: string; refresh_token: string; expires_in: number }) {
  await mkdir(".tokens", { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 }), { mode: 0o600 });
}
