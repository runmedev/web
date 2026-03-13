export type PersistentStorageStatus =
  | "unsupported"
  | "already-persistent"
  | "persisted"
  | "not-granted"
  | "error";

interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

function getStorageManager(): StorageManagerLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return (navigator.storage as StorageManagerLike | undefined) ?? null;
}

/**
 * Attempt to make origin storage persistent to reduce eviction under storage
 * pressure. Browsers can still decline this request based on heuristics.
 */
export async function ensurePersistentStorage(
  storageManager: StorageManagerLike | null = getStorageManager(),
): Promise<PersistentStorageStatus> {
  if (!storageManager || typeof storageManager.persist !== "function") {
    return "unsupported";
  }

  if (typeof storageManager.persisted === "function") {
    try {
      const alreadyPersisted = await storageManager.persisted();
      if (alreadyPersisted) {
        return "already-persistent";
      }
    } catch {
      // Ignore persisted() read failures and still try requesting persistence.
    }
  }

  try {
    const granted = await storageManager.persist();
    return granted ? "persisted" : "not-granted";
  } catch {
    return "error";
  }
}
