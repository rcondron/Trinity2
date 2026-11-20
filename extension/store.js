// Where the extension keeps its key pair and the engine's pinned key: IndexedDB. A CryptoKey is stored as it is — the
// private half was made non-extractable, so nothing (this extension's own code included) can read its bytes back out;
// it can only be used to derive the shared key.

const DB = "trinity-bridge";
const STORE = "keys";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("couldn't open the key store"));
  });
}

async function withStore(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error || new Error("the key store failed"));
      tx.onabort = () => reject(tx.error || new Error("the key store gave up"));
    });
  } finally {
    db.close();
  }
}

export const getItem = (key) => withStore("readonly", (s) => s.get(key));
export const setItem = (key, value) => withStore("readwrite", (s) => s.put(value, key));
export const delItem = (key) => withStore("readwrite", (s) => s.delete(key));

/** The extension's key pair, made on first use. */
export async function loadKeys(generate) {
  let pair = await getItem("pair");
  if (!pair || !pair.privateKey || !pair.publicKey) {
    pair = await generate();
    await setItem("pair", pair);
  }
  return pair;
}

/** The engine this extension is paired with: {pub, pairedAt}, or null. */
export const pinnedEngine = async () => (await getItem("engine")) || null;
export const pinEngine = (pub) => setItem("engine", { pub, pairedAt: Date.now() });
export const forgetEngine = () => delItem("engine");
