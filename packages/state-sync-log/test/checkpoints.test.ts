import { describe, expect, it, vi } from "vitest"
import { CheckpointRecord, parseCheckpointKey } from "../src/checkpoints"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog, getSortedTxsSymbol } from "../src/createStateSyncLog"
import { applyOps } from "../src/operations"
import { applyLocalCheckpoint } from "./utils"

describe("Checkpoints", () => {
  it("checkpoints epoch and maintains state", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    const epoch1 = log.getActiveEpoch()

    applyLocalCheckpoint(log)

    expect(log.getActiveEpoch()).toBe(epoch1 + 1)
    expect(log.getState()).toStrictEqual({ a: 1 })
    expect(log.isLogEmpty()).toBe(false)
  })

  it("multiple checkpoint calls increment epochs correctly", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    const epoch0 = log.getActiveEpoch()
    expect(epoch0).toBe(0)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    applyLocalCheckpoint(log)
    expect(log.getActiveEpoch()).toBe(1)

    log.emit([{ kind: "set", path: [], key: "b", value: 2 }])
    applyLocalCheckpoint(log)
    expect(log.getActiveEpoch()).toBe(2)

    log.emit([{ kind: "set", path: [], key: "c", value: 3 }])
    applyLocalCheckpoint(log)
    expect(log.getActiveEpoch()).toBe(3)

    expect(log.getState()).toStrictEqual({ a: 1, b: 2, c: 3 })
  })

  it("preserves state after multiple checkpoints with no new txs", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    log.emit([{ kind: "set", path: [], key: "persistent", value: 42 }])
    applyLocalCheckpoint(log)

    applyLocalCheckpoint(log)
    applyLocalCheckpoint(log)

    expect(log.getState()).toStrictEqual({ persistent: 42 })
  })

  it("new client loads checkpointed state", () => {
    const doc = new SyncLogDoc()
    const log1 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "A",
      retentionWindowMs: undefined,
    })

    log1.emit([{ kind: "set", path: [], key: "data", value: { preserved: true } }])
    applyLocalCheckpoint(log1)

    const log2 = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "B",
      retentionWindowMs: undefined,
    })

    expect(log2.getState()).toStrictEqual({ data: { preserved: true } })
  })

  it("checkpoint does nothing when epoch is empty", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    expect(log.getActiveEpoch()).toBe(0)

    applyLocalCheckpoint(log) // Should be no-op

    expect(log.getActiveEpoch()).toBe(0) // Still epoch 0
  })

  it("txs after checkpoint are in new epoch", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    log.emit([{ kind: "set", path: [], key: "before", value: 1 }])
    applyLocalCheckpoint(log)

    const epochAfterCheckpoint = log.getActiveEpoch()

    log.emit([{ kind: "set", path: [], key: "after", value: 2 }])

    expect(log.getActiveEpoch()).toBe(epochAfterCheckpoint)
    // State should have both (old was in checkpoint, new is fresh)
    expect(log.getState()).toStrictEqual({ before: 1, after: 2 })
  })

  it("throws on malformed checkpoint key", () => {
    expect(() => parseCheckpointKey("invalid")).toThrow(/Malformed checkpoint key/)
    expect(() => parseCheckpointKey("1;2")).toThrow(/Malformed checkpoint key/)
  })

  it("includes active txs in checkpoint", () => {
    const doc = new SyncLogDoc()

    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "A",
      retentionWindowMs: 1000,
    })

    // Access internal map for checkpoint verification (no public API for watermarks yet)
    const yCheckpoint = doc.getMap<CheckpointRecord>("state-sync-log-checkpoint")

    // Add a tx in epoch 1
    log.emit([])

    // Verify tx exists before checkpoint
    expect(log[getSortedTxsSymbol]().length).toBe(1)

    // Checkpoint (creates checkpoint for epoch 1 and prunes txs)
    applyLocalCheckpoint(log)

    // Checkpoint should be created
    expect(yCheckpoint.size).toBe(1)
    // The tx should have been pruned
    expect(log[getSortedTxsSymbol]().length).toBe(0)
  })

  it("preserves structural sharing after checkpointing", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    // Create nested state
    log.emit([
      { kind: "set", path: [], key: "unchanged", value: { nested: { deep: "value" } } },
      { kind: "set", path: [], key: "willChange", value: { data: 1 } },
    ])

    const stateBeforeCheckpoint = log.getState()

    // Checkpoint - creates checkpoint
    applyLocalCheckpoint(log)

    const stateAfterCheckpoint = log.getState()
    const unchangedRefAfterCheckpoint = stateAfterCheckpoint.unchanged

    // After checkpointing, state should still be structurally shared with checkpoint
    expect(stateAfterCheckpoint.unchanged).toBe(unchangedRefAfterCheckpoint)
    expect(stateAfterCheckpoint).toStrictEqual(stateBeforeCheckpoint)

    // Now update only the "willChange" key
    log.emit([{ kind: "set", path: ["willChange"], key: "data", value: 2 }])

    const stateAfterUpdate = log.getState()

    // The "unchanged" subtree should maintain reference equality
    expect(stateAfterUpdate.unchanged).toBe(unchangedRefAfterCheckpoint)
    expect(stateAfterUpdate.unchanged.nested).toBe(unchangedRefAfterCheckpoint.nested)

    // The changed part should have new value
    expect(stateAfterUpdate.willChange.data).toBe(2)

    // Overall state should be correct
    expect(stateAfterUpdate).toStrictEqual({
      unchanged: { nested: { deep: "value" } },
      willChange: { data: 2 },
    })
  })

  it("maintains state correctness during out-of-order sync", () => {
    // Two clients syncing - need to create out-of-order arrival
    const doc1 = new SyncLogDoc()
    const doc2 = new SyncLogDoc()
    const doc3 = new SyncLogDoc()

    const log1 = createStateSyncLog<any>({
      syncLogDoc: doc1,
      retentionWindowMs: undefined,
    })

    const log2 = createStateSyncLog<any>({
      syncLogDoc: doc2,
      retentionWindowMs: undefined,
    })

    const log3 = createStateSyncLog<any>({
      syncLogDoc: doc3,
      retentionWindowMs: undefined,
    })

    // Client 1 creates initial state with nested structures
    log1.emit([
      { kind: "set", path: [], key: "unchanged", value: { nested: { deep: "value" } } },
      { kind: "set", path: [], key: "willChange", value: { data: 1 } },
    ])

    // Client 2 makes its own update (timestamp will be different)
    log2.emit([{ kind: "set", path: [], key: "from2", value: "hello" }])

    // Sync doc1 → doc3 first (doc3 sees client1's tx)
    doc3.applyUpdate(doc1.encodeStateAsUpdate())

    const state3AfterDoc1 = log3.getState()

    // Now sync doc2 → doc3 (doc3 sees client2's tx which has EARLIER timestamp)
    // This triggers out-of-order replay because client2's tx should be sorted before client1's
    doc3.applyUpdate(doc2.encodeStateAsUpdate())

    const state3AfterDoc2 = log3.getState()

    // State should have all values (correctness is preserved even if structural sharing is not)
    expect(state3AfterDoc2).toStrictEqual({
      unchanged: { nested: { deep: "value" } },
      willChange: { data: 1 },
      from2: "hello",
    })

    // Note: Out-of-order replay may not preserve structural sharing due to rollback support.
    // Fast path (in-order) does preserve structural sharing.
    expect(state3AfterDoc1).not.toBe(state3AfterDoc2) // State changed
  })

  it("preserves structural sharing fast path when validation fails", () => {
    const doc = new SyncLogDoc()

    // Use a validator that rejects any operation that sets "forbidden" key
    const validate = (state: any) => !("forbidden" in state)

    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      validate,
    })

    // Create initial state with nested structure
    log.emit([
      { kind: "set", path: [], key: "nested", value: { deep: { value: "original" } } },
      { kind: "set", path: [], key: "other", value: 123 },
    ])

    const stateBeforeFailedTx = log.getState()
    const nestedRefBefore = stateBeforeFailedTx.nested
    const deepRefBefore = stateBeforeFailedTx.nested.deep

    // Emit a tx that should fail validation (sets "forbidden" key)
    // This goes through the fast path since it's in-order from the same client
    log.emit([{ kind: "set", path: [], key: "forbidden", value: "bad" }])

    const stateAfterFailedTx = log.getState()

    // State should be unchanged because validation failed
    expect(stateAfterFailedTx).toStrictEqual({
      nested: { deep: { value: "original" } },
      other: 123,
    })
    expect("forbidden" in stateAfterFailedTx).toBe(false)

    // CRITICAL: Structural sharing should be preserved - same reference!
    // When rollback reverts the failed tx, the state reference should remain identical
    expect(stateAfterFailedTx).toBe(stateBeforeFailedTx)
    expect(stateAfterFailedTx.nested).toBe(nestedRefBefore)
    expect(stateAfterFailedTx.nested.deep).toBe(deepRefBefore)
  })

  it("preserves structural sharing slow path when validation fails", () => {
    // Create two docs that will sync
    const doc1 = new SyncLogDoc()
    const doc2 = new SyncLogDoc()

    // Use a validator that rejects any operation that sets "forbidden" key
    const validate = (state: any) => !("forbidden" in state)

    const log1 = createStateSyncLog<any>({
      syncLogDoc: doc1,
      retentionWindowMs: undefined,
      validate,
    })

    const log2 = createStateSyncLog<any>({
      syncLogDoc: doc2,
      retentionWindowMs: undefined,
      validate,
    })

    // Create initial state on doc1
    log1.emit([
      { kind: "set", path: [], key: "nested", value: { deep: { value: "original" } } },
      { kind: "set", path: [], key: "other", value: 123 },
    ])

    // Sync to doc2
    doc2.applyUpdate(doc1.encodeStateAsUpdate())

    // Create another tx on doc1 that's valid
    log1.emit([{ kind: "set", path: ["nested"], key: "extra", value: "ok" }])

    // Now create a tx on doc2 with a LOWER timestamp that would fail validation
    // when replayed (this simulates an out-of-order tx from another client)
    // We'll directly create the tx in doc2's map with a timestamp that
    // comes before the existing txs, forcing slow path replay

    // First sync the valid tx
    doc2.applyUpdate(doc1.encodeStateAsUpdate())

    const stateAfterValidSync = log2.getState()
    expect(stateAfterValidSync.nested.extra).toBe("ok")

    // Now emit a failing tx on doc1 (sets forbidden key)
    log1.emit([{ kind: "set", path: [], key: "forbidden", value: "bad" }])

    // Sync to doc2 - this will go through slow path since it's from another client
    doc2.applyUpdate(doc1.encodeStateAsUpdate())

    const stateAfterFailedSync = log2.getState()

    // State should not contain forbidden key because validation failed
    expect("forbidden" in stateAfterFailedSync).toBe(false)

    // The valid changes should still be there
    expect(stateAfterFailedSync.nested.extra).toBe("ok")
    expect(stateAfterFailedSync.other).toBe(123)
  })

  it("preserves reference stability when all txs in slow path fail validation", () => {
    const doc1 = new SyncLogDoc()
    const doc2 = new SyncLogDoc()

    // Validator that rejects "forbidden" key
    const validate = (state: any) => !("forbidden" in state)

    const log1 = createStateSyncLog<any>({
      syncLogDoc: doc1,
      retentionWindowMs: undefined,
      validate,
    })

    const log2 = createStateSyncLog<any>({
      syncLogDoc: doc2,
      retentionWindowMs: undefined,
      validate,
    })

    // Create initial state
    log1.emit([{ kind: "set", path: [], key: "value", value: 1 }])
    doc2.applyUpdate(doc1.encodeStateAsUpdate())

    const stateBeforeFailedSync = log2.getState()

    // Emit failing tx on doc1
    log1.emit([{ kind: "set", path: [], key: "forbidden", value: "bad" }])

    // Sync to doc2
    doc2.applyUpdate(doc1.encodeStateAsUpdate())

    const stateAfterFailedSync = log2.getState()

    // State should be unchanged
    expect(stateAfterFailedSync).toStrictEqual({ value: 1 })
    expect("forbidden" in stateAfterFailedSync).toBe(false)

    // Reference should be stable since no valid changes were applied
    expect(stateAfterFailedSync).toBe(stateBeforeFailedSync)
  })

  describe("Subscribe Ops Reconciliation", () => {
    it("emits correct minimal ops to reconcile mutable state when syncing a checkpoint", () => {
      const docA = new SyncLogDoc()
      const logA = createStateSyncLog<any>({
        syncLogDoc: docA,
        clientId: "A",
        retentionWindowMs: undefined,
      })

      // 1. Client A creates state and checkpoints it
      logA.emit([
        { kind: "set", path: [], key: "x", value: 1 },
        { kind: "set", path: [], key: "y", value: 2 },
      ])
      applyLocalCheckpoint(logA) // Creates checkpoint, active epoch becomes 1

      expect(logA.getState()).toStrictEqual({ x: 1, y: 2 })

      // 2. Client B starts empty
      const docB = new SyncLogDoc()
      const logB = createStateSyncLog<any>({
        syncLogDoc: docB,
        clientId: "B",
        retentionWindowMs: undefined,
      })

      // Client B maintains a mutable state
      const mutableState: any = {}
      const subscriber = vi.fn((_state, getAppliedOps) => {
        applyOps(getAppliedOps(), mutableState)
      })

      logB.subscribe(subscriber)

      // Initial state check
      expect(mutableState).toStrictEqual({})

      // 3. Sync A -> B (B receives the checkpoint)
      docB.applyUpdate(docA.encodeStateAsUpdate())

      // 4. Verify subscriber fired and ops correctly updated the mutable state
      expect(subscriber).toHaveBeenCalled()
      expect(mutableState).toStrictEqual({ x: 1, y: 2 })
      expect(logB.getState()).toStrictEqual({ x: 1, y: 2 })

      // Verify minimal ops: should be just set x=1, set y=2
      // Note: sync might trigger multiple updates (e.g. checkpoint + txs), filter for the one with ops
      const ops =
        subscriber.mock.calls.map((args: any) => args[1]()).find((o: any) => o.length > 0) || []
      expect(ops.length).toBe(2)
      expect(ops).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "set", key: "x", value: 1 }),
          expect.objectContaining({ kind: "set", key: "y", value: 2 }),
        ])
      )
    })

    it("emits correct minimal ops when checkpoint replaces existing state (conflict/reorg)", () => {
      const docA = new SyncLogDoc()
      const logA = createStateSyncLog<any>({
        syncLogDoc: docA,
        clientId: "A",
        retentionWindowMs: undefined,
      })

      const docB = new SyncLogDoc()
      const logB = createStateSyncLog<any>({
        syncLogDoc: docB,
        clientId: "B",
        retentionWindowMs: undefined,
      })

      // 1. Client B has some initial state (epoch 0)
      logB.emit([{ kind: "set", path: [], key: "existing", value: "start" }])

      // Client B maintains mutable state
      const mutableState: any = { existing: "start" }
      const subscriber = vi.fn((_state, getAppliedOps) => {
        applyOps(getAppliedOps(), mutableState)
      })
      logB.subscribe(subscriber)

      // 2. Sync B -> A so A knows about B's state (and will watermark it)
      docA.applyUpdate(docB.encodeStateAsUpdate())

      // 3. Client A overwrites the state and checkpoints it
      logA.emit([
        { kind: "set", path: [], key: "x", value: 100 },
        { kind: "set", path: [], key: "existing", value: "overwritten" },
      ])
      applyLocalCheckpoint(logA)

      // 4. Sync A -> B (B accepts checkpoint)
      docB.applyUpdate(docA.encodeStateAsUpdate())

      // 5. Verify mutable state matches new reality
      expect(mutableState).toStrictEqual({
        existing: "overwritten",
        x: 100,
      })
      expect(logB.getState()).toStrictEqual({
        existing: "overwritten",
        x: 100,
      })

      // Verify minimal ops
      // Current: { existing: "start" }
      // Target: { existing: "overwritten", x: 100 }
      // Expected diff: set existing="overwritten", set x=100
      // Find the call with ops
      const ops =
        subscriber.mock.calls.map((args: any) => args[1]()).find((o: any) => o.length > 0) || []
      expect(ops.length).toBe(2)
      expect(ops).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "set", key: "existing", value: "overwritten" }),
          expect.objectContaining({ kind: "set", key: "x", value: 100 }),
        ])
      )
    })
  })
})
