import { expect } from "vitest"
import type { CheckpointData } from "../src/checkpoints"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import type { StateSyncLogController } from "../src/createStateSyncLog"
import type { JSONObject } from "../src/json"

/**
 * Helper for single-client tests: creates and immediately adds a checkpoint.
 * In production, servers should use createCheckpoint() + broadcast + addCheckpoint().
 */
export function applyLocalCheckpoint(log: StateSyncLogController<any>): void {
  const cp = log.createCheckpoint()
  if (cp) log.addCheckpoint(cp)
}

/**
 * Syncs two SyncLogDoc instances bidirectionally.
 * Simulates a network round-trip where both clients exchange their updates.
 */
export function syncDocs(docA: SyncLogDoc, docB: SyncLogDoc): void {
  const stateA = docA.encodeStateAsUpdate()
  const stateB = docB.encodeStateAsUpdate()
  docB.applyUpdate(stateA)
  docA.applyUpdate(stateB)
}

/**
 * Helper to assert that both logs have converged to the same state.
 */
export function expectConvergence(
  logA: StateSyncLogController<JSONObject>,
  logB: StateSyncLogController<JSONObject>
): void {
  const stateA = logA.getState()
  const stateB = logB.getState()
  expect(stateA).toStrictEqual(stateB)
}

/**
 * Server-mediated checkpointing helper:
 * 1. Sync all docs first
 * 2. Create checkpoint on one log
 * 3. Broadcast to all logs
 * 4. Sync again
 */
export function applyServerCheckpoint(
  docs: SyncLogDoc[],
  logs: StateSyncLogController<any>[],
  checkpointerIndex = 0
): CheckpointData | null {
  // Sync all docs first
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      syncDocs(docs[i], docs[j])
    }
  }

  // Create checkpoint on checkpointer
  const checkpoint = logs[checkpointerIndex].createCheckpoint()

  // Broadcast to all logs
  if (checkpoint) {
    for (const log of logs) {
      log.addCheckpoint(checkpoint)
    }
  }

  // Sync again
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      syncDocs(docs[i], docs[j])
    }
  }

  return checkpoint
}
