import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CheckpointRecord, parseCheckpointKey } from "../src/checkpoints"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog, getSortedTxsSymbol } from "../src/createStateSyncLog"

describe("Retention Window", () => {
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("txs within retention window are preserved", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: TWO_WEEKS_MS,
      autoCompact: () => false,
    })

    // Create tx at time 0
    vi.setSystemTime(0)
    log.emit([{ kind: "set", path: [], key: "early", value: 1 }])

    // Advance time by 1 week (still within 2 week window)
    vi.setSystemTime(ONE_WEEK_MS)
    log.emit([{ kind: "set", path: [], key: "later", value: 2 }])

    // Compact
    log.compact()

    // Both txs should be in the state (within retention)
    expect(log.getState()).toStrictEqual({ early: 1, later: 2 })
  })

  it("watermarks for inactive clients are pruned after retention window", () => {
    const doc = new SyncLogDoc()

    // Start at time 0
    vi.setSystemTime(0)

    const logA = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "A",
      retentionWindowMs: ONE_WEEK_MS,
      autoCompact: () => false,
    })

    // A makes a change and COMPACTS (validating epoch 1, saving watermarks)
    logA.emit([{ kind: "set", path: [], key: "fromA", value: 1 }])
    logA.compact()

    // Advance time beyond retention window
    vi.setSystemTime(ONE_WEEK_MS + 1000)

    // Create another client
    const logB = createStateSyncLog<any>({
      syncLogDoc: doc,
      clientId: "B",
      retentionWindowMs: ONE_WEEK_MS,
      autoCompact: () => false,
    })

    // B makes a change
    logB.emit([{ kind: "set", path: [], key: "fromB", value: 2 }])

    // B compacts - A's watermark should be pruned from the NEW checkpoint
    logB.compact()

    // State should still contain both values (A is applied from checkpoint state, B is new)
    const state = logB.getState()
    expect(state.fromA).toBe(1)
    expect(state.fromB).toBe(2)

    // Verify internally that A's watermark is gone
    // We can check the actual checkpoint map
    const yCheckpoint = doc.getMap<CheckpointRecord>("state-sync-log-checkpoint")
    // Should be at least one checkpoint (latest).
    // The key format is epoch;txCount;clientId
    // B compacted, so B created a checkpoint for the new epoch (Epoch 2 presumably, or 1 if A made 0 to 1).
    // Wait, A compacted Epoch 1 (0->1). logA.compact() makes Epoch 1 finalized.
    // B starts. Active Epoch is 2. B emits. B compacts. Finalizes Epoch 2.
    // Checkpoint for Epoch 2 should NOT have A in watermarks.

    // Find checkpoint for epoch 2 (or generally, the latest)
    // Checkpoint key with highest epoch
    let maxEpoch = -1
    let latestCP: CheckpointRecord | null = null

    for (const [key, val] of yCheckpoint.entries()) {
      const { epoch } = parseCheckpointKey(key)
      if (epoch > maxEpoch) {
        maxEpoch = epoch
        latestCP = val
      }
    }

    expect(latestCP).toBeDefined()
    expect(latestCP!.watermarks.A).toBeUndefined()
    expect(latestCP!.watermarks.B).toBeDefined()
  })

  it("ancient txs from finalized epochs are not re-emitted", () => {
    const doc = new SyncLogDoc()

    vi.setSystemTime(0)

    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: ONE_WEEK_MS,
      autoCompact: () => false,
    })

    // Create tx and compact
    log.emit([{ kind: "set", path: [], key: "old", value: 1 }])
    log.compact()

    // Advance time way beyond retention
    vi.setSystemTime(TWO_WEEKS_MS)

    // Add new tx in new epoch
    log.emit([{ kind: "set", path: [], key: "new", value: 2 }])

    // State should have both (old was in checkpoint, new is fresh)
    expect(log.getState()).toStrictEqual({ old: 1, new: 2 })

    // The ancient tx should NOT be in the sorted log anymore (it was pruned)
    // Only the 'new' tx should remain.
    const txs = log[getSortedTxsSymbol]()
    expect(txs.length).toBe(1)
    expect(txs[0].txRecord!.ops[0]).toMatchObject({ key: "new" })
  })

  it("retentionWindowMs of undefined means no pruning (infinite retention)", () => {
    const doc = new SyncLogDoc()

    vi.setSystemTime(0)

    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
    })

    log.emit([{ kind: "set", path: [], key: "ancient", value: 1 }])

    // Advance time by 100 years
    vi.setSystemTime(100 * 365 * 24 * 60 * 60 * 1000)

    log.emit([{ kind: "set", path: [], key: "future", value: 2 }])
    log.compact()

    // Both should be preserved with infinite retention
    expect(log.getState()).toStrictEqual({ ancient: 1, future: 2 })
  })

  it("two clients with retention window handle offline rejoin", () => {
    const docA = new SyncLogDoc()
    const docB = new SyncLogDoc()

    vi.setSystemTime(0)

    const logA = createStateSyncLog<any>({
      syncLogDoc: docA,
      clientId: "A",
      retentionWindowMs: ONE_WEEK_MS,
      autoCompact: () => false,
    })

    const logB = createStateSyncLog<any>({
      syncLogDoc: docB,
      clientId: "B",
      retentionWindowMs: ONE_WEEK_MS,
      autoCompact: () => false,
    })

    // A makes changes
    logA.emit([{ kind: "set", path: [], key: "a1", value: 1 }])

    // Sync
    const stateA1 = docA.encodeStateAsUpdate()
    docB.applyUpdate(stateA1)

    expect(logB.getState()).toStrictEqual({ a1: 1 })

    // B goes offline for 2 weeks
    vi.setSystemTime(TWO_WEEKS_MS)

    // A continues making changes and compacts
    logA.emit([{ kind: "set", path: [], key: "a2", value: 2 }])
    logA.compact()

    // B comes back online with a very old tx
    logB.emit([{ kind: "set", path: [], key: "bOld", value: "old" }])

    // Sync both ways
    const stateA2 = docA.encodeStateAsUpdate()
    const stateB = docB.encodeStateAsUpdate()
    docB.applyUpdate(stateA2)
    docA.applyUpdate(stateB)

    // Both should eventually converge
    // B's old tx may or may not be included depending on when it was created
    // relative to the checkpoint's minWallClock
    const finalStateA = logA.getState()
    const finalStateB = logB.getState()

    expect(finalStateA).toStrictEqual(finalStateB)
    expect(finalStateA.a1).toBe(1)
    expect(finalStateA.a2).toBe(2)
  })

  it("short retention window prunes quickly", () => {
    const doc = new SyncLogDoc()
    const SHORT_RETENTION = 1000 // 1 second

    vi.setSystemTime(0)

    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: SHORT_RETENTION,
      autoCompact: () => false,
    })

    log.emit([{ kind: "set", path: [], key: "t0", value: 0 }])

    vi.setSystemTime(500)
    log.emit([{ kind: "set", path: [], key: "t500", value: 500 }])

    vi.setSystemTime(1000)
    log.emit([{ kind: "set", path: [], key: "t1000", value: 1000 }])

    log.compact()

    // All should be in state since they're all within the same epoch
    expect(log.getState()).toStrictEqual({ t0: 0, t500: 500, t1000: 1000 })

    // Now advance far beyond retention
    vi.setSystemTime(5000)
    log.emit([{ kind: "set", path: [], key: "t5000", value: 5000 }])

    expect(log.getState()).toStrictEqual({ t0: 0, t500: 500, t1000: 1000, t5000: 5000 })
  })
})
