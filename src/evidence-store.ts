export type EvidenceEvent = { kind: string; [key: string]: unknown };
export interface EvidenceStore {
  initialize(context: string, event: EvidenceEvent): Promise<void>;
  append(context: string, event: EvidenceEvent): Promise<void>;
  read(context: string): Promise<EvidenceEvent[]>;
  contexts(): Promise<string[]>;
}

// Transaction completion, not request success, is the commit boundary. No keys
// or mutable simulation snapshots are stored: replay reconstructs public history.
export class BrowserEvidenceStore implements EvidenceStore {
  private db: Promise<IDBDatabase>;
  constructor(name = "crypto-fighter-evidence-v1") {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const events = request.result.createObjectStore("events", { autoIncrement: true });
        events.createIndex("context", "context");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Evidence database blocked"));
    });
  }
  async initialize(context: string, event: EvidenceEvent) {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("events", "readwrite", { durability: "strict" });
      const events = tx.objectStore("events");
      const count = events.index("context").count(context);
      count.onsuccess = () => {
        if (count.result) { tx.abort(); return; }
        events.add({ context, event });
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error("Existing evidence is inspection-only; use a fresh session"));
      tx.onerror = () => reject(tx.error);
    });
  }
  async append(context: string, event: EvidenceEvent) {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("events", "readwrite", { durability: "strict" });
      tx.objectStore("events").add({ context, event });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Evidence commit aborted"));
      tx.onerror = () => reject(tx.error);
    });
  }
  async read(context: string): Promise<EvidenceEvent[]> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readonly");
      const request = tx.objectStore("events").index("context").getAll(context);
      tx.oncomplete = () => resolve(request.result.map(row => row.event));
      tx.onabort = () => reject(tx.error);
    });
  }
  async contexts(): Promise<string[]> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readonly");
      const keys = tx.objectStore("events").index("context").openKeyCursor(null, "nextunique");
      const contexts: string[] = [];
      keys.onsuccess = () => { if (keys.result) { contexts.push(String(keys.result.key)); keys.result.continue(); } };
      tx.oncomplete = () => resolve(contexts);
      tx.onabort = () => reject(tx.error);
    });
  }
}
