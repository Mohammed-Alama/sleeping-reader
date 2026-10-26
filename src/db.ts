export interface StoredPdf {
  id: string;
  name: string;
  slug?: string;
  bytes: ArrayBuffer;
  updatedAt: number;
}

const DB_NAME = 'sleeping-reader';
const LEGACY_DB_NAME = 'sleep-pdf';
const DB_VERSION = 1;
const STORE = 'file';

export function slugify(name: string): string {
  const base = name.replace(/\.pdf$/i, '').trim();
  const slug = base
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || encodeURIComponent(base.toLowerCase()) || 'document';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Saves or updates a PDF in the library without removing existing ones. */
export async function savePdf(record: StoredPdf): Promise<void> {
  const database = await openDb();
  try {
    if (!record.slug) {
      record.slug = slugify(record.name);
    }
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    database.close();
  }
}

/** Returns all stored books sorted by most recently opened. */
export async function getAllPdfs(): Promise<StoredPdf[]> {
  const database = await openDb();
  try {
    let records = await new Promise<StoredPdf[]>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as StoredPdf[]);
      request.onerror = () => reject(request.error);
    });

    if (records.length === 0) {
      try {
        const legacyRecords = await new Promise<StoredPdf[]>((resolve) => {
          const req = indexedDB.open(LEGACY_DB_NAME, 1);
          req.onsuccess = () => {
            const legDb = req.result;
            if (!legDb.objectStoreNames.contains(STORE)) {
              legDb.close();
              resolve([]);
              return;
            }
            const ltx = legDb.transaction(STORE, 'readonly');
            const lreq = ltx.objectStore(STORE).getAll();
            lreq.onsuccess = () => {
              const res = lreq.result as StoredPdf[];
              legDb.close();
              resolve(res || []);
            };
            lreq.onerror = () => {
              legDb.close();
              resolve([]);
            };
          };
          req.onerror = () => resolve([]);
        });

        if (legacyRecords.length > 0) {
          for (const rec of legacyRecords) {
            await savePdf(rec);
          }
          records = legacyRecords;
        }
      } catch {
        // migration fallback
      }
    }

    records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return records;
  } finally {
    database.close();
  }
}

/** Finds a PDF by either its ID, stored slug, or computed slug from its name. */
export async function getPdfBySlugOrId(identifier: string): Promise<StoredPdf | null> {
  const clean = identifier.replace(/^\/+/, '').trim().toLowerCase();
  if (!clean) return null;
  const all = await getAllPdfs();
  return (
    all.find(
      (doc) =>
        doc.id.toLowerCase() === clean ||
        (doc.slug && doc.slug.toLowerCase() === clean) ||
        slugify(doc.name) === clean,
    ) ?? null
  );
}

/** Deletes a PDF by its id. */
export async function deletePdf(id: string): Promise<void> {
  const database = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    database.close();
  }
}

export async function getLatestPdf(): Promise<StoredPdf | null> {
  const all = await getAllPdfs();
  return all[0] ?? null;
}

