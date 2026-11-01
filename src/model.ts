export type Outcome = "RECEIPT FOUND" | "NO MATCH" | "CAN'T TELL";
export interface Utterance { start: number; end: number; text: string; confidence?: number; }
export interface ChatMessage { userId: string; username: string; text: string; isMod: boolean; isBroadcaster: boolean; }
export interface Receipt {
  id: string; outcome: Outcome; query: string; quote?: string; timestamp?: number;
  context?: string; clipStart?: number; clipEnd?: number; requester: string;
  status: "pending" | "vetoed" | "played"; reason?: string;
}
