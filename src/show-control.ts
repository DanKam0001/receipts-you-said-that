import type { Outcome, Receipt } from "./model.js";

export const ANNOUNCER_FILES = ["found.mp3", "nomatch.mp3", "canttell.mp3", "vetoed.mp3", "played.mp3", "replay.mp3"] as const;
export type AnnouncerFile = typeof ANNOUNCER_FILES[number];

export function announcerForOutcome(outcome: Outcome): AnnouncerFile {
  if (outcome === "RECEIPT FOUND") return "found.mp3";
  if (outcome === "NO MATCH") return "nomatch.mp3";
  return "canttell.mp3";
}

export function selectReplayReceipt<T extends Pick<Receipt, "status">>(receipts: readonly T[], ordinal?: number): T | undefined {
  const played = receipts.filter(item => item.status === "played");
  if (ordinal === undefined) return played.at(-1);
  if (!Number.isInteger(ordinal) || ordinal < 1) return undefined;
  return played[ordinal - 1];
}

export function replayCooldownRemaining(lastStartedAt: number | undefined, now: number, cooldownSeconds: number): number {
  if (lastStartedAt === undefined) return 0;
  return Math.max(0, Math.ceil((lastStartedAt + Math.max(0, cooldownSeconds) * 1000 - now) / 1000));
}

export function maySettle(isMod: boolean, isBroadcaster: boolean): boolean {
  return isMod || isBroadcaster;
}
