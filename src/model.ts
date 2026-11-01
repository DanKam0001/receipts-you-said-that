export type Outcome = "RECEIPT FOUND" | "NO MATCH" | "CAN'T TELL";
export interface WordTiming { text: string; start: number; end: number; estimated?: boolean; }
export interface Utterance { start: number; end: number; text: string; confidence?: number; embedding?: number[]; words?: WordTiming[]; }
export interface ChatMessage { userId: string; username: string; text: string; isMod: boolean; isBroadcaster: boolean; }
export interface Receipt {
  id: string; outcome: Outcome; query: string; quote?: string; timestamp?: number;
  context?: string; quoteEnd?: number; quoteWords?: WordTiming[]; clipStart?: number; clipEnd?: number; requester: string; score: number;
  decisionMs?: number;
  status: "pending" | "vetoed" | "played"; reason?: string; candidateId?: string; retrievalScore?: number; vetoUntil?: number;
}
