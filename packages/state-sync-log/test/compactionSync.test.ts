import { describe, expect, it } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog, type StateSyncLogController } from "../src/index"

/**
 * Helper to sync two docs via their update mechanism.
 */
function syncDocs(doc1: SyncLogDoc, doc2: SyncLogDoc) {
  const state1 = doc1.encodeStateAsUpdate()
  const state2 = doc2.encodeStateAsUpdate()
  doc2.applyUpdate(state1)
  doc1.applyUpdate(state2)
}

/**
 * Helper: ensure logs have converged to the same state.
 */
function expectConvergence(logA: StateSyncLogController<any>, logB: StateSyncLogController<any>) {
  expect(logA.getState()).toStrictEqual(logB.getState())
}

describe("Compaction Sync Disconnected", () => {
  // skipped for now since this is expected from spec to happen
  it.skip("handles two clients writing txs and compacting multiple times while unsynced, then syncing", async () => {
    // Setup 2 isolated docs
    const docA = new SyncLogDoc()
    const docB = new SyncLogDoc()

    const logA = createStateSyncLog<any>({
      syncLogDoc: docA,
      clientId: "A",
      retentionWindowMs: undefined, // Infinite retention
      autoCompact: () => false,
    })

    const logB = createStateSyncLog<any>({
      syncLogDoc: docB,
      clientId: "B",
      retentionWindowMs: undefined, // Infinite retention
      autoCompact: () => false,
    })

    // --- Phase 1: Independent Operations ---

    // A writes Tx1
    logA.emit([{ kind: "set", path: [], key: "A_tx1", value: 1 }])
    // A compact (Checkpoint A1)
    logA.compact()

    // A writes Tx2
    logA.emit([{ kind: "set", path: [], key: "A_tx2", value: 2 }])
    // A compact (Checkpoint A2)
    logA.compact()

    // B writes Tx3
    logB.emit([{ kind: "set", path: [], key: "B_tx3", value: 3 }])
    // B compact (Checkpoint B1)
    logB.compact()

    // B writes Tx4
    logB.emit([{ kind: "set", path: [], key: "B_tx4", value: 4 }])
    // B compact (Checkpoint B2)
    logB.compact()

    // Validating divergent state
    const stateA_local = logA.getState()
    const stateB_local = logB.getState()

    // A should have A_tx1, A_tx2
    expect(stateA_local).toEqual({
      A_tx1: 1,
      A_tx2: 2,
    })

    // B should have B_tx3, B_tx4
    expect(stateB_local).toEqual({
      B_tx3: 3,
      B_tx4: 4,
    })

    // --- Connect and Sync ---
    const stateA = docA.encodeStateAsUpdate()
    const stateB = docB.encodeStateAsUpdate()

    // Sync A -> B
    docB.applyUpdate(stateA)

    // Sync B -> A
    docA.applyUpdate(stateB)

    // Sync again to propagate any re-emitted transactions (reconciliation)
    syncDocs(docA, docB)

    // --- Assertions ---
    expectConvergence(logA, logB)

    const finalState = logA.getState()

    // All values should be present
    expect(finalState).toEqual({
      A_tx1: 1,
      A_tx2: 2,
      B_tx3: 3,
      B_tx4: 4,
    })
  })
})
