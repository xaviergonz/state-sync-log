import { describe, expect, it } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog } from "../src/index"
import { applyServerCheckpoint, expectConvergence, syncDocs } from "./utils"

describe("Server Checkpoint", () => {
  it("server checkpoint preserves all client data", () => {
    // Setup 2 isolated docs
    const docA = new SyncLogDoc()
    const docB = new SyncLogDoc()

    const logA = createStateSyncLog<any>({
      syncLogDoc: docA,
      clientId: "A",
      retentionWindowMs: undefined,
    })

    const logB = createStateSyncLog<any>({
      syncLogDoc: docB,
      clientId: "B",
      retentionWindowMs: undefined,
    })

    // --- Phase 1: Independent Operations (both clients offline) ---

    // A writes Tx1
    logA.emit([{ kind: "set", path: [], key: "A_tx1", value: 1 }])

    // A writes Tx2
    logA.emit([{ kind: "set", path: [], key: "A_tx2", value: 2 }])

    // B writes Tx3
    logB.emit([{ kind: "set", path: [], key: "B_tx3", value: 3 }])

    // B writes Tx4
    logB.emit([{ kind: "set", path: [], key: "B_tx4", value: 4 }])

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

    // --- Phase 2: Connect and Sync (server establishes connection) ---
    syncDocs(docA, docB)

    // Both should now have all data
    expectConvergence(logA, logB)
    expect(logA.getState()).toEqual({
      A_tx1: 1,
      A_tx2: 2,
      B_tx3: 3,
      B_tx4: 4,
    })

    // --- Phase 3: Server checkpoint ---
    // Server asks A to create checkpoint, then broadcasts to all
    const checkpoint = applyServerCheckpoint([docA, docB], [logA, logB], 0)

    expect(checkpoint).not.toBeNull()

    // --- Assertions ---
    expectConvergence(logA, logB)

    const finalState = logA.getState()

    // All values should be present (no data loss!)
    expect(finalState).toEqual({
      A_tx1: 1,
      A_tx2: 2,
      B_tx3: 3,
      B_tx4: 4,
    })
  })

  it("multiple server checkpoints work correctly", () => {
    const docA = new SyncLogDoc()
    const docB = new SyncLogDoc()

    const logA = createStateSyncLog<any>({
      syncLogDoc: docA,
      clientId: "A",
      retentionWindowMs: undefined,
    })

    const logB = createStateSyncLog<any>({
      syncLogDoc: docB,
      clientId: "B",
      retentionWindowMs: undefined,
    })

    // Round 1: A adds data, checkpoint
    logA.emit([{ kind: "set", path: [], key: "round1", value: 1 }])
    syncDocs(docA, docB)
    applyServerCheckpoint([docA, docB], [logA, logB], 0)

    expect(logA.getActiveEpoch()).toBe(1)
    expect(logB.getActiveEpoch()).toBe(1)

    // Round 2: B adds data, checkpoint
    logB.emit([{ kind: "set", path: [], key: "round2", value: 2 }])
    syncDocs(docA, docB)
    applyServerCheckpoint([docA, docB], [logA, logB], 1)

    expect(logA.getActiveEpoch()).toBe(2)
    expect(logB.getActiveEpoch()).toBe(2)

    expectConvergence(logA, logB)
    expect(logA.getState()).toEqual({
      round1: 1,
      round2: 2,
    })
  })

  it("createCheckpoint returns null when epoch is empty", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "test",
      retentionWindowMs: undefined,
    })

    // No transactions emitted
    const checkpoint = log.createCheckpoint()
    expect(checkpoint).toBeNull()
  })

  it("createCheckpoint returns correct data structure", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "test",
      retentionWindowMs: undefined,
    })

    log.emit([{ kind: "set", path: [], key: "x", value: 1 }])

    const checkpoint = log.createCheckpoint()
    expect(checkpoint).not.toBeNull()
    expect(checkpoint!.key).toContain("test")
    expect(checkpoint!.key).toContain(";0;;") // epoch 0
    expect(checkpoint!.record.state).toEqual({ x: 1 })
    expect(checkpoint!.record.txCount).toBe(1)
    expect(checkpoint!.record.watermarks).toHaveProperty("test")
  })
})
