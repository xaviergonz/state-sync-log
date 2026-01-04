import { describe, expect, it } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog, getSortedTxsSymbol } from "../src/createStateSyncLog"

describe("Sync", () => {
  it("syncs between two clients", async () => {
    const doc = new SyncLogDoc()
    const log1 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "A",
      retentionWindowMs: undefined,
    })
    const log2 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "B",
      retentionWindowMs: undefined,
    })

    log1.emit([{ kind: "set", path: [], key: "msg", value: "hello" }])

    expect(log1.getState()).toStrictEqual({ msg: "hello" })
    expect(log2.getState()).toStrictEqual({ msg: "hello" })
  })

  it("handles out-of-order txs", () => {
    const doc = new SyncLogDoc()
    const log1 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "A",
      retentionWindowMs: undefined,
    })
    const log2 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "B",
      retentionWindowMs: undefined,
    })

    log1.emit([{ kind: "set", path: [], key: "x", value: 1 }]) // Clock 1
    log2.emit([{ kind: "set", path: [], key: "x", value: 2 }]) // Clock 2 (sees Clock 1)

    // Final state should be x=2 because Clock 2 > Clock 1
    expect(log1.getState().x).toBe(2)
    expect(log2.getState().x).toBe(2)
  })

  it("maintains Lamport clock monotonicity with rapid emissions", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    for (let i = 0; i < 10; i++) {
      log.emit([{ kind: "set", path: [], key: `key${i}`, value: i }])
    }

    const state = log.getState()
    for (let i = 0; i < 10; i++) {
      expect(state[`key${i}`]).toBe(i)
    }
  })

  it("checkpoint state is preserved and loaded by new client", () => {
    const doc = new SyncLogDoc()
    const log1 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "A",
      retentionWindowMs: undefined,
    })

    log1.emit([{ kind: "set", path: [], key: "data", value: { preserved: true } }])
    log1.compact()

    const log2 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "B",
      retentionWindowMs: undefined,
    })

    expect(log2.getState()).toStrictEqual({ data: { preserved: true } })
  })

  it("both clients see same state after concurrent edits", () => {
    const doc = new SyncLogDoc()
    const log1 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "A",
      retentionWindowMs: undefined,
    })
    const log2 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "B",
      retentionWindowMs: undefined,
    })

    log1.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    log2.emit([{ kind: "set", path: [], key: "b", value: 2 }])

    expect(log1.getState()).toStrictEqual({ a: 1, b: 2 })
    expect(log2.getState()).toStrictEqual({ a: 1, b: 2 })
  })

  it("re-emits missed txs in order after checkpoint sync", () => {
    // Setup: Two isolated SyncLogDoc instances (simulating network separation)
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

    // Step 1: Client A creates multiple ordered txs while offline
    // These use an array to track the expected final order
    logA.emit([{ kind: "set", path: [], key: "step1", value: "first" }])
    logA.emit([{ kind: "set", path: [], key: "step2", value: "second" }])
    logA.emit([{ kind: "set", path: [], key: "step3", value: "third" }])
    logA.emit([{ kind: "set", path: [], key: "order", value: [1] }])
    logA.emit([{ kind: "set", path: [], key: "order", value: [1, 2] }])
    logA.emit([{ kind: "set", path: [], key: "order", value: [1, 2, 3] }])

    // Step 2: Client B creates its own tx AND compacts
    // This creates a checkpoint that does NOT include A's txs
    logB.emit([{ kind: "set", path: [], key: "fromB", value: "B was here" }])
    logB.compact()

    // Verify B has compacted (epoch 1, A's txs not in checkpoint)
    expect(logB.getActiveEpoch()).toBe(1)

    // Step 3: Sync B's state (with checkpoint) to A
    // A will receive the checkpoint and must re-emit its missed txs
    const stateB = docB.encodeStateAsUpdate()
    docA.applyUpdate(stateB)

    // Step 4: Verify A's state includes both:
    // - B's checkpoint content
    // - A's re-emitted txs (applied in correct order)
    const stateA = logA.getState()
    expect(stateA.fromB).toBe("B was here") // From B's checkpoint
    expect(stateA.step1).toBe("first") // A's re-emitted
    expect(stateA.step2).toBe("second") // A's re-emitted
    expect(stateA.step3).toBe("third") // A's re-emitted
    // The order array should have final value [1, 2, 3] from ordered application
    expect(stateA.order).toStrictEqual([1, 2, 3])

    // Step 5: Now sync A back to B to complete convergence
    const stateA2 = docA.encodeStateAsUpdate()
    docB.applyUpdate(stateA2)

    // Both should have identical state
    expect(logA.getState()).toStrictEqual(logB.getState())
    expect(logB.getState().order).toStrictEqual([1, 2, 3])
  })

  describe("Advanced Sync Scenarios", () => {
    it("prunes redundant re-emits when switching to a better checkpoint", () => {
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

      // 1. B creates checkpoint (Epoch 0 -> 1) early, so it misses A's future events.
      logB.emit([{ kind: "set", path: [], key: "setup", value: "init" }])
      logB.compact()

      // Sync B's state (with checkpoint) to A first, so they have same base
      const initSync = docB.encodeStateAsUpdate()
      docA.applyUpdate(initSync)

      // 2. A emits T1 (now in Epoch 2 relative to A since it received B's checkpoint).
      logA.emit([{ kind: "set", path: [], key: "a", value: 1 }])

      // 3. Sync A -> B.
      // B receives T1.
      const stateA = docA.encodeStateAsUpdate()
      docB.applyUpdate(stateA)

      // Verification: Both should have the same state
      expect(logA.getState()).toStrictEqual(logB.getState())
      expect(logB.getState()).toStrictEqual({ setup: "init", a: 1 })
    })

    it("deduplicates re-emits correctly", () => {
      const docA = new SyncLogDoc()
      const logA = createStateSyncLog<any>({
        syncLogDoc: docA,
        clientId: "A",
        retentionWindowMs: undefined,
      })
      logA.emit([{ kind: "set", path: [], key: "arr", value: [] }])

      const docB = new SyncLogDoc()
      const logB = createStateSyncLog<any>({
        syncLogDoc: docB,
        clientId: "B",
        retentionWindowMs: undefined,
      })

      // Sync init state
      const init = docA.encodeStateAsUpdate()
      docB.applyUpdate(init)

      // A emits T1 (push 1)
      logA.emit([{ kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [1] }])

      // B compact (Epoch 0->1). Missed T1.
      logB.compact()

      // B receives T1.
      // T1 is from A and in a finalized epoch but NOT in B's checkpoint.
      // B keeps T1 to apply its state correctly.
      const updateT1 = docA.encodeStateAsUpdate()
      docB.applyUpdate(updateT1)

      const txsB = logB[getSortedTxsSymbol]()
      // T1 is kept because it's not covered by B's checkpoint
      expect(txsB.length).toBe(1)

      // A receives B's state (just the checkpoint).
      const updateB = docB.encodeStateAsUpdate()
      docA.applyUpdate(updateB)

      // Both should have the same state
      expect(logA.getState()).toStrictEqual(logB.getState())
      expect((logA.getState().arr as number[]).length).toBe(1)
    })
  })

  describe("set undefined vs delete sync", () => {
    it("syncs set undefined correctly between clients", () => {
      const doc = new SyncLogDoc()
      const log1 = createStateSyncLog<any>({
        syncLogDoc: doc,
        clientId: "A",
        retentionWindowMs: undefined,
      })
      const log2 = createStateSyncLog<any>({
        syncLogDoc: doc,
        clientId: "B",
        retentionWindowMs: undefined,
      })

      // Initial state
      log1.emit([{ kind: "set", path: [], key: "a", value: 1 }])
      log1.emit([{ kind: "set", path: [], key: "b", value: 2 }])

      // Set b to undefined
      log1.emit([{ kind: "set", path: [], key: "b", value: undefined }])

      // Both clients should have b with undefined value
      const state1 = log1.getState()
      const state2 = log2.getState()

      expect("b" in state1).toBe(true)
      expect("b" in state2).toBe(true)
      expect(state1.b).toBe(undefined)
      expect(state2.b).toBe(undefined)
      expect(state1).toStrictEqual(state2)
    })

    it("syncs delete correctly between clients", () => {
      const doc = new SyncLogDoc()
      const log1 = createStateSyncLog<any>({
        syncLogDoc: doc,
        clientId: "A",
        retentionWindowMs: undefined,
      })
      const log2 = createStateSyncLog<any>({
        syncLogDoc: doc,
        clientId: "B",
        retentionWindowMs: undefined,
      })

      // Initial state
      log1.emit([{ kind: "set", path: [], key: "a", value: 1 }])
      log1.emit([{ kind: "set", path: [], key: "b", value: 2 }])

      // Delete b
      log1.emit([{ kind: "delete", path: [], key: "b" }])

      // Both clients should NOT have b key
      const state1 = log1.getState()
      const state2 = log2.getState()

      expect("b" in state1).toBe(false)
      expect("b" in state2).toBe(false)
      expect(Object.keys(state1)).toEqual(["a"])
      expect(Object.keys(state2)).toEqual(["a"])
      expect(state1).toStrictEqual(state2)
    })

    it("preserves set undefined vs delete distinction after sync", () => {
      const doc = new SyncLogDoc()
      const log1 = createStateSyncLog<any>({
        syncLogDoc: doc,
        clientId: "A",
        retentionWindowMs: undefined,
      })
      const log2 = createStateSyncLog<any>({
        syncLogDoc: doc,
        clientId: "B",
        retentionWindowMs: undefined,
      })

      // Setup
      log1.emit([{ kind: "set", path: [], key: "keep", value: 1 }])
      log1.emit([{ kind: "set", path: [], key: "setUndefined", value: "initial" }])
      log1.emit([{ kind: "set", path: [], key: "toDelete", value: "initial" }])

      // Set one key to undefined, delete another
      log1.emit([{ kind: "set", path: [], key: "setUndefined", value: undefined }])
      log1.emit([{ kind: "delete", path: [], key: "toDelete" }])

      const state1 = log1.getState()
      const state2 = log2.getState()

      // Verify distinction is preserved
      expect("setUndefined" in state1).toBe(true)
      expect("setUndefined" in state2).toBe(true)
      expect("toDelete" in state1).toBe(false)
      expect("toDelete" in state2).toBe(false)

      expect(state1).toStrictEqual(state2)
      expect(Object.keys(state1).sort()).toEqual(["keep", "setUndefined"])
    })

    it("preserves distinction after checkpoint", () => {
      const doc = new SyncLogDoc()
      const log1 = createStateSyncLog<any>({
        syncLogDoc: doc,
        clientId: "A",
        retentionWindowMs: 5000,
      })
      const log2 = createStateSyncLog<any>({
        syncLogDoc: doc,
        clientId: "B",
        retentionWindowMs: 5000,
      })

      // Setup
      log1.emit([{ kind: "set", path: [], key: "keep", value: 1 }])
      log1.emit([{ kind: "set", path: [], key: "setUndefined", value: undefined }])
      log1.emit([{ kind: "set", path: [], key: "toDelete", value: 2 }])
      log1.emit([{ kind: "delete", path: [], key: "toDelete" }])

      // Compact to create checkpoint
      log1.compact()

      // Verify distinction is preserved after checkpoint
      const state1 = log1.getState()
      const state2 = log2.getState()

      expect("setUndefined" in state1).toBe(true)
      expect("setUndefined" in state2).toBe(true)
      expect("toDelete" in state1).toBe(false)
      expect("toDelete" in state2).toBe(false)

      expect(state1).toStrictEqual(state2)
    })

    it("new client joining after checkpoint sees correct state", () => {
      const doc1 = new SyncLogDoc()
      const log1 = createStateSyncLog<any>({
        syncLogDoc: doc1,
        clientId: "A",
        retentionWindowMs: 5000,
      })

      // Create state with set undefined and delete
      log1.emit([{ kind: "set", path: [], key: "a", value: 1 }])
      log1.emit([{ kind: "set", path: [], key: "b", value: undefined }])
      log1.emit([{ kind: "set", path: [], key: "c", value: 2 }])
      log1.emit([{ kind: "delete", path: [], key: "c" }])

      // Compact
      log1.compact()

      // New client joins
      const doc2 = new SyncLogDoc()
      doc2.applyUpdate(doc1.encodeStateAsUpdate())

      const log2 = createStateSyncLog<any>({
        syncLogDoc: doc2,
        clientId: "B",
        retentionWindowMs: 5000,
      })

      const state2 = log2.getState()
      expect("a" in state2).toBe(true)
      expect("b" in state2).toBe(true)
      expect("c" in state2).toBe(false)
      expect(state2.a).toBe(1)
      expect(state2.b).toBe(undefined)

      expect(state2).toStrictEqual(log1.getState())
    })
  })
})
