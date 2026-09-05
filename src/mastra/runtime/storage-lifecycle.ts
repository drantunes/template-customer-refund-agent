/**
 * Mastra owns initialization of its composite storage. App-owned tables share
 * the local file, so their first migration waits for that canonical async init
 * rather than racing Mastra's per-domain DDL.
 */
let mastraStorageReady: Promise<void> = Promise.resolve();

export function setMastraStorageReady(ready: Promise<void>) {
  mastraStorageReady = ready;
}

export function waitForMastraStorage() {
  return mastraStorageReady;
}
