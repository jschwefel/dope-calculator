/**
 * IndexedDB wrapper for ammo storage and server sync.
 */

const DB_NAME      = 'dopeDB';
const DB_VERSION   = 1;
const STORE_AMMO   = 'ammo';

let _db = null;

function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_AMMO)) {
                db.createObjectStore(STORE_AMMO, { keyPath: 'name' });
            }
        };
        req.onsuccess = e => { _db = e.target.result; resolve(_db); };
        req.onerror   = e => reject(e.target.error);
    });
}

export async function initDB() {
    await openDB();
}

export async function getAmmo() {
    const db    = await openDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_AMMO, 'readonly');
        const req = tx.objectStore(STORE_AMMO).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

export async function saveAmmo(entries) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE_AMMO, 'readwrite');
        const store = tx.objectStore(STORE_AMMO);
        store.clear();
        for (const entry of entries) store.put(entry);
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
    });
}

export async function addAmmoLocal(entry) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_AMMO, 'readwrite');
        const req = tx.objectStore(STORE_AMMO).put(entry);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

export async function syncAmmoFromServer() {
    try {
        const res  = await fetch('/api/ammo', { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return false;
        const data = await res.json();
        await saveAmmo(data.ammo || []);
        return true;
    } catch {
        return false;
    }
}
