import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ArchivedReceipt {
  id: string;
  quote?: string;
  timestamp?: number;
  quoteEnd?: number;
  clipStart?: number;
  clipEnd?: number;
  requester: string;
  outcome: "RECEIPT FOUND";
  score: number;
  candidateId?: string;
  retrievalScore?: number;
  savedAt: string;
  wav: string;
}

export class ReceiptStore {
  constructor(private readonly root: string) {}

  async save(record: Omit<ArchivedReceipt, "savedAt" | "wav">, wavClip: Buffer): Promise<number> {
    if (!/^[a-f0-9-]{36}$/i.test(record.id)) throw new Error("Invalid receipt ID");
    await mkdir(this.root, { recursive: true });
    const wav = `${record.id}.wav`;
    const archived: ArchivedReceipt = { ...record, savedAt: new Date().toISOString(), wav };
    await writeFile(resolve(this.root, wav), wavClip);
    await writeFile(resolve(this.root, `${record.id}.json`), JSON.stringify(archived, null, 2), "utf8");
    return (await readdir(this.root)).filter(name => /^[a-f0-9-]{36}\.json$/i.test(name)).length;
  }

  async list(): Promise<ArchivedReceipt[]> {
    try {
      const names = (await readdir(this.root)).filter(name => /^[a-f0-9-]{36}\.json$/i.test(name));
      const rows = await Promise.all(names.map(async name => JSON.parse(await readFile(resolve(this.root, name), "utf8")) as ArchivedReceipt));
      return rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } catch { return []; }
  }

  async clip(id: string): Promise<Buffer | undefined> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return undefined;
    try { return await readFile(resolve(this.root, `${id}.wav`)); }
    catch { return undefined; }
  }

  async remove(id: string): Promise<number> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return (await this.list()).length;
    await Promise.all([unlink(resolve(this.root, `${id}.wav`)).catch(() => undefined), unlink(resolve(this.root, `${id}.json`)).catch(() => undefined)]);
    return (await this.list()).length;
  }
}
