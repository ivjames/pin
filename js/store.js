// IndexedDB persistence: imported media blobs and the autosaved project. Everything stays in the browser.

const DB_NAME = 'cornerpin';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const putMedia = (rec) => tx('media', 'readwrite', (s) => s.put(rec));
export const deleteMedia = (id) => tx('media', 'readwrite', (s) => s.delete(id));
export const allMedia = () => tx('media', 'readonly', (s) => s.getAll());
export const getKV = (key) => tx('kv', 'readonly', (s) => s.get(key));
export const setKV = (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key));

/** Ask the browser not to evict our storage under pressure. Resolves to true when granted. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (_) { /* not available */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (_) { /* not available */ }
  return null;
}
