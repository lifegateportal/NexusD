/**
 * ebook-job-store.ts
 * IndexedDB persistence for ebook generation jobs.
 * Each section is saved immediately after completion — pipeline is fully resumable.
 */

import type { EbookJobState } from "@/lib/schemas/ebook";

const DB_NAME = "nexus-ebook-jobs";
const STORE_NAME = "jobs";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "jobId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveEbookJob(state: EbookJobState, retries = 2): Promise<void> {
  // Sync to R2 check-point asynchronously (Audit C-3 + U-1)
  fetch(`/api/ebook/jobs/${state.jobId}/checkpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  }).catch(err => console.error("Checkpoint sync failed:", err));

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put({ ...state, updatedAt: new Date().toISOString() });
        tx.oncomplete = () => {
          console.log(`[ebook-job-store] Saved job ${state.jobId} (${state.currentStage})`);
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
      return;
    } catch (err) {
      const isLastAttempt = attempt === retries;
      console.error(`[ebook-job-store] Save failed (attempt ${attempt + 1}/${retries + 1}):`, err);
      if (isLastAttempt) throw err;
      await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

export async function getEbookJob(jobId: string): Promise<EbookJobState | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(jobId);
    req.onsuccess = () => resolve((req.result as EbookJobState) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function listEbookJobs(): Promise<EbookJobState[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .getAll();
    req.onsuccess = () => resolve((req.result as EbookJobState[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteEbookJob(jobId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(jobId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function newJobId(): string {
  return `ebook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
