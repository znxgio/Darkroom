// Demo mode only: a tiny key → record store for photo blobs.
// Uses IndexedDB so photos survive a reload; falls back to memory where IndexedDB
// isn't available (unit tests, some private-browsing modes).

export interface BlobRecord {
  key: string;
  day: string;
  kind: 'face' | 'body';
  blob: Blob;
  created_at: number;
}

export interface BlobStore {
  put(r: BlobRecord): Promise<void>;
  all(): Promise<BlobRecord[]>;
}

const STORE = 'photos';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function memoryStore(): BlobStore {
  const m = new Map<string, BlobRecord>();
  return {
    async put(r) {
      m.set(r.key, r);
    },
    async all() {
      return [...m.values()];
    },
  };
}

export function blobStore(dbName: string): BlobStore {
  if (typeof indexedDB === 'undefined') return memoryStore();
  let dbp: Promise<IDBDatabase> | null = null;
  const fallback = memoryStore();
  let useFallback = false;

  function db(): Promise<IDBDatabase> {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'key' });
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
    }
    return dbp;
  }

  async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
    const d = await db();
    const tx = d.transaction(STORE, mode);
    const out = await req(fn(tx.objectStore(STORE)));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return out;
  }

  return {
    async put(r) {
      if (!useFallback) {
        try {
          await withStore('readwrite', (s) => s.put(r));
          return;
        } catch {
          useFallback = true;
        }
      }
      await fallback.put(r);
    },
    async all() {
      if (!useFallback) {
        try {
          return await withStore('readonly', (s) => s.getAll() as IDBRequest<BlobRecord[]>);
        } catch {
          useFallback = true;
        }
      }
      return fallback.all();
    },
  };
}
