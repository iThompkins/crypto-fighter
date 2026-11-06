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
  private contextDbs = new Map<string, Promise<IDBDatabase>>();
  private name: string;
  constructor(name = "crypto-fighter-evidence-v1") {
    this.name = name;
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("events")) {
          const events = request.result.createObjectStore("events", { autoIncrement: true });
          events.createIndex("context", "context");
        }
        if (!request.result.objectStoreNames.contains("contexts")) request.result.createObjectStore("contexts");
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Evidence database blocked"));
    });
  }
  private journalName(context: string) { return `${this.name}:journal:${context}`; }
  private contextDb(context: string) {
    let opened = this.contextDbs.get(context);
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.journalName(context), 1);
      request.onupgradeneeded = () => request.result.createObjectStore("events", { autoIncrement: true });
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Evidence journal blocked"));
    });
    this.contextDbs.set(context, opened);
    return opened;
  }
  private async registered(context: string) {
    const db = await this.db;
    const catalogued = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction("contexts", "readonly");
      const request = tx.objectStore("contexts").getKey(context);
      tx.oncomplete = () => resolve(request.result !== undefined);
      tx.onabort = () => reject(tx.error);
    });
    if (catalogued) return true;
    const databases = await indexedDB.databases?.();
    return databases?.some(database => database.name === this.journalName(context)) ?? false;
  }
  private async legacyExists(context: string) {
    const db = await this.db;
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction("events", "readonly");
      const request = tx.objectStore("events").index("context").count(context);
      tx.oncomplete = () => resolve(request.result > 0);
      tx.onabort = () => reject(tx.error);
    });
  }
  async initialize(context: string, event: EvidenceEvent) {
    if (await this.registered(context) || await this.legacyExists(context)) {
      throw new Error("Existing evidence is inspection-only; use a fresh session");
    }
    const db = await this.contextDb(context);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("events", "readwrite", { durability: "relaxed" });
      const events = tx.objectStore("events");
      const count = events.count();
      count.onsuccess = () => {
        if (count.result) { tx.abort(); return; }
        events.add(event);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error("Existing evidence is inspection-only; use a fresh session"));
      tx.onerror = () => reject(tx.error);
    });
    const registry = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = registry.transaction("contexts", "readwrite", { durability: "relaxed" });
      tx.objectStore("contexts").put(true, context);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
  async append(context: string, event: EvidenceEvent) {
    const db = await this.contextDb(context);
    await new Promise<void>((resolve, reject) => {
      // Completion remains the send/use boundary. Relaxed durability avoids a
      // physical disk flush for every 30 Hz packet; a sudden power/OS loss can
      // drop the newest rows, which recovery already treats as unavailable
      // evidence rather than fabricating gameplay authority.
      const tx = db.transaction("events", "readwrite", { durability: "relaxed" });
      tx.objectStore("events").add(event);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Evidence commit aborted"));
      tx.onerror = () => reject(tx.error);
    });
  }
  async read(context: string): Promise<EvidenceEvent[]> {
    if (!(await this.registered(context))) {
      const db = await this.db;
      return new Promise((resolve, reject) => {
        const tx = db.transaction("events", "readonly");
        const request = tx.objectStore("events").index("context").getAll(context);
        tx.oncomplete = () => resolve(request.result.map(row => row.event));
        tx.onabort = () => reject(tx.error);
      });
    }
    const db = await this.contextDb(context);
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readonly");
      const request = tx.objectStore("events").getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  }
  async contexts(): Promise<string[]> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readonly");
      const keys = tx.objectStore("events").index("context").openKeyCursor(null, "nextunique");
      const contexts = new Set<string>();
      keys.onsuccess = () => { if (keys.result) { contexts.add(String(keys.result.key)); keys.result.continue(); } };
      tx.oncomplete = () => {
        const registry = db.transaction("contexts", "readonly");
        const request = registry.objectStore("contexts").getAllKeys();
        registry.oncomplete = async () => {
          try {
            const prefix = `${this.name}:journal:`;
            const journals = (await indexedDB.databases?.() ?? [])
              .map(database => database.name ?? "")
              .filter(name => name.startsWith(prefix))
              .map(name => name.slice(prefix.length));
            resolve([...contexts, ...request.result.map(String), ...journals].filter((value, index, all) => all.indexOf(value) === index));
          } catch (error) { reject(error); }
        };
        registry.onabort = () => reject(registry.error);
      };
      tx.onabort = () => reject(tx.error);
    });
  }
}
