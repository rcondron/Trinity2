import { DpapiDeviceKey, dpapiAvailable } from "./dpapi.js";
import { vaultDir } from "./policy.js";
import { VaultStore } from "./store.js";

/** The engine's one vault (made on first use; made again if the vault folder setting changes, as tests do). */
let store: VaultStore | null = null;
let storeDir = "";
const lockListeners = new Set<() => void>();

export function vault(): VaultStore {
  const dir = vaultDir();
  if (!store || dir !== storeDir) {
    void store?.lock();
    storeDir = dir;
    store = new VaultStore({ dir, device: dpapiAvailable() ? new DpapiDeviceKey(dir) : null });
    for (const fn of lockListeners) store.onLock(fn);
  }
  return store;
}

/** Called whenever the vault locks (by hand, after fifteen idle minutes, or because it may no longer be used). */
export function onVaultLock(fn: () => void): void {
  lockListeners.add(fn);
  store?.onLock(fn);
}
