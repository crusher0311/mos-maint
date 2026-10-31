/** Browser-only durable raw-segment outbox. Values are never placed in local
 * storage, URLs or logs. Quota failures reject and must stop capture explicitly. */
export type PendingRecordingSegment = {
  key: string; scope: string; recordingId: string; sequence: number;
  visitId: string; durationSeconds: number; mime: string; blob: Blob;
};
const databaseName = "mos-visit-recording-outbox-v1";
const maximumBytes = 120 * 1024 * 1024;
const maximumEntries = 30;
export class RecordingOutbox {
  private connection: Promise<IDBDatabase> | null = null;
  private open() {
    if (!this.connection) this.connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("segments", {keyPath: "key"});
        store.createIndex("scope", "scope", {unique: false});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error("Recording storage unavailable; use manual inspection"));
      request.onblocked = () => reject(Error("Close other inspection tabs before opening recording storage"));
    });
    return this.connection;
  }
  async list(scope: string): Promise<PendingRecordingSegment[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("segments", "readonly");
      const request = tx.objectStore("segments").index("scope").getAll(scope);
      let rows: PendingRecordingSegment[] = [];
      request.onsuccess = () => {rows = request.result;};
      tx.oncomplete = () => resolve(rows.sort((a, b) => a.sequence - b.sequence));
      tx.onabort = tx.onerror = () => reject(Error("Saved recording queue could not be read"));
    });
  }
  async put(value: PendingRecordingSegment) {
    if (!value.scope || !value.recordingId || !Number.isInteger(value.sequence) || value.sequence < 0 || value.sequence >= 30 ||
      value.blob.size <= 0 || value.blob.size > 4 * 1024 * 1024 ||
      value.key !== JSON.stringify([value.scope, value.recordingId, value.sequence])) throw Error("Invalid recording segment");
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("segments", "readwrite"), store = tx.objectStore("segments");
      const request = store.getAll();
      let failure = "Recording storage failed. Stop recording and retain available footage.";
      request.onsuccess = () => {
        const rows = request.result as PendingRecordingSegment[];
        // Count all device scopes without exposing other contributors' data.
        // Do not silently evict another visit's recoverable footage.
        if (rows.some(row => row.key === value.key)) {
          failure = "Recording segment already retained; retry its original upload";
          tx.abort(); return;
        }
        if (rows.length >= maximumEntries || rows.reduce((total, row) => total + row.blob.size, 0) + value.blob.size > maximumBytes) {
          failure = "Recording storage limit reached. Resolve pending uploads before recording more.";
          tx.abort(); return;
        }
        store.add(value);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(Error(failure));
    });
  }
  async acknowledge(scope: string, key: string) {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("segments", "readwrite"), store = tx.objectStore("segments");
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result && request.result.scope !== scope) {tx.abort(); return;}
        if (request.result) store.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(Error("Recording acknowledgment could not be saved"));
    });
  }
  async close() {
    if (this.connection) (await this.connection).close();
    this.connection = null;
  }
}
