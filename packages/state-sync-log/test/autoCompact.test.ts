import { describe, expect, it, vi } from "vitest"
import type { AutoCompactParams } from "../src"
import { createStateSyncLog, SyncLogDoc } from "../src"

describe("autoCompact", () => {
  it("should call autoCompact callback after each tx", () => {
    const doc = new SyncLogDoc()
    const autoCompactSpy = vi.fn(() => false)

    const log = createStateSyncLog<{ value: number }>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: autoCompactSpy,
    })

    expect(autoCompactSpy).not.toHaveBeenCalled()

    log.emit([{ kind: "set", path: [], key: "value", value: 1 }])

    expect(autoCompactSpy).toHaveBeenCalledTimes(1)
    expect(autoCompactSpy).toHaveBeenCalledWith({
      txLog: { size: 1, ops: 1 },
      lastCompactionTime: undefined,
    })

    log.emit([{ kind: "set", path: [], key: "value", value: 2 }])

    expect(autoCompactSpy).toHaveBeenCalledTimes(2)
    expect(autoCompactSpy).toHaveBeenLastCalledWith({
      txLog: { size: 2, ops: 2 },
      lastCompactionTime: undefined,
    })

    log.dispose()
  })

  it("should auto-compact when callback returns true", () => {
    const doc = new SyncLogDoc()

    const log = createStateSyncLog<{ value: number }>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: ({ txLog }) => txLog.size >= 3,
    })

    expect(log.getActiveEpoch()).toBe(0)
    expect(log.getActiveEpochTxCount()).toBe(0)

    log.emit([{ kind: "set", path: [], key: "value", value: 1 }])
    expect(log.getActiveEpoch()).toBe(0)
    expect(log.getActiveEpochTxCount()).toBe(1)

    log.emit([{ kind: "set", path: [], key: "value", value: 2 }])
    expect(log.getActiveEpoch()).toBe(0)
    expect(log.getActiveEpochTxCount()).toBe(2)

    // This third tx should trigger auto-compact
    log.emit([{ kind: "set", path: [], key: "value", value: 3 }])
    expect(log.getActiveEpoch()).toBe(1) // Epoch advanced
    expect(log.getActiveEpochTxCount()).toBe(0) // Txs compacted

    log.dispose()
  })

  it("should auto-compact based on ops count", () => {
    const doc = new SyncLogDoc()

    const log = createStateSyncLog<{ a: number; b: number; c: number }>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: ({ txLog }) => txLog.ops >= 5,
    })

    expect(log.getActiveEpoch()).toBe(0)
    expect(log.getActiveEpochOpsCount()).toBe(0)

    // Emit tx with 2 ops
    log.emit([
      { kind: "set", path: [], key: "a", value: 1 },
      { kind: "set", path: [], key: "b", value: 2 },
    ])
    expect(log.getActiveEpochOpsCount()).toBe(2)
    expect(log.getActiveEpoch()).toBe(0)

    // Emit tx with 2 more ops (4 total)
    log.emit([
      { kind: "set", path: [], key: "a", value: 10 },
      { kind: "set", path: [], key: "b", value: 20 },
    ])
    expect(log.getActiveEpochOpsCount()).toBe(4)
    expect(log.getActiveEpoch()).toBe(0)

    // Emit tx with 2 more ops (6 total) - should trigger compact
    log.emit([
      { kind: "set", path: [], key: "a", value: 100 },
      { kind: "set", path: [], key: "c", value: 3 },
    ])
    expect(log.getActiveEpoch()).toBe(1) // Epoch advanced
    expect(log.getActiveEpochOpsCount()).toBe(0)

    log.dispose()
  })

  it("should provide accurate lastCompactionTime", async () => {
    const doc = new SyncLogDoc()
    let capturedParams: AutoCompactParams | null = null

    const log = createStateSyncLog<{ value: number }>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: (params) => {
        capturedParams = params
        return false
      },
    })

    log.emit([{ kind: "set", path: [], key: "value", value: 1 }])

    expect(capturedParams).not.toBeNull()
    // lastCompactionTime should be undefined since no checkpoint exists yet
    expect(capturedParams!.lastCompactionTime).toBeUndefined()

    log.dispose()
  })

  it("should set lastCompactionTime after auto-compact", async () => {
    const doc = new SyncLogDoc()
    const capturedTimes: (number | undefined)[] = []

    const log = createStateSyncLog<{ value: number }>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: (params) => {
        capturedTimes.push(params.lastCompactionTime)
        return params.txLog.size >= 2 // Compact on 2nd tx
      },
    })

    log.emit([{ kind: "set", path: [], key: "value", value: 1 }])
    // First lastCompactionTime should be undefined (no checkpoint yet)
    expect(capturedTimes[0]).toBeUndefined()

    // This triggers compact
    log.emit([{ kind: "set", path: [], key: "value", value: 2 }])
    // Second call still sees undefined (compact happens after callback)
    expect(capturedTimes[1]).toBeUndefined()

    const compactTime = Date.now()

    await new Promise((resolve) => setTimeout(resolve, 20))

    // Third tx after compact - lastCompactionTime should now be set
    log.emit([{ kind: "set", path: [], key: "value", value: 3 }])
    const time3 = capturedTimes[2]

    // Time should be close to when the compact happened
    expect(time3).toBeDefined()
    expect(time3).toBeGreaterThanOrEqual(compactTime - 50)
    expect(time3).toBeLessThanOrEqual(compactTime + 50)

    log.dispose()
  })

  it("should preserve state after auto-compact", () => {
    const doc = new SyncLogDoc()

    const log = createStateSyncLog<{ items: { id: number; name: string }[] }>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: ({ txLog }) => txLog.size >= 2,
    })

    log.emit([{ kind: "set", path: [], key: "items", value: [] }])
    log.emit([
      {
        kind: "splice",
        path: ["items"],
        index: 0,
        deleteCount: 0,
        inserts: [{ id: 1, name: "A" }],
      },
    ])

    // Verify compact happened
    expect(log.getActiveEpoch()).toBe(1)

    // Verify state is preserved
    expect(log.getState()).toEqual({
      items: [{ id: 1, name: "A" }],
    })

    // Add more data
    log.emit([
      {
        kind: "splice",
        path: ["items"],
        index: 1,
        deleteCount: 0,
        inserts: [{ id: 2, name: "B" }],
      },
    ])
    log.emit([{ kind: "set", path: ["items", 0], key: "name", value: "Updated" }])

    // Verify another compact happened
    expect(log.getActiveEpoch()).toBe(2)

    // Verify state is preserved
    expect(log.getState()).toEqual({
      items: [
        { id: 1, name: "Updated" },
        { id: 2, name: "B" },
      ],
    })

    log.dispose()
  })

  it("should not call autoCompact on checkpoint changes", () => {
    const doc = new SyncLogDoc()
    const autoCompactSpy = vi.fn(() => false)

    const log = createStateSyncLog<{ value: number }>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: autoCompactSpy,
    })

    log.emit([{ kind: "set", path: [], key: "value", value: 1 }])
    expect(autoCompactSpy).toHaveBeenCalledTimes(1)

    // Manual compact should not trigger autoCompact callback again
    log.compact()
    expect(autoCompactSpy).toHaveBeenCalledTimes(1) // Still 1

    log.dispose()
  })

  it("should work with validation", () => {
    const doc = new SyncLogDoc()

    const log = createStateSyncLog<{ count: number }>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      validate: (state) => state.count <= 10,
      autoCompact: ({ txLog }) => txLog.size >= 2,
    })

    log.emit([{ kind: "set", path: [], key: "count", value: 5 }])
    log.emit([{ kind: "set", path: [], key: "count", value: 8 }])

    expect(log.getActiveEpoch()).toBe(1)
    expect(log.getState()).toEqual({ count: 8 })

    // Try to set invalid value - should be rejected
    log.emit([{ kind: "set", path: [], key: "count", value: 15 }])
    expect(log.getState()).toEqual({ count: 8 }) // Still 8

    log.dispose()
  })

  it("getActiveEpochOpsCount should track correctly", () => {
    const doc = new SyncLogDoc()

    const log = createStateSyncLog<{ a: number; b: number }>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    expect(log.getActiveEpochOpsCount()).toBe(0)
    expect(log.getActiveEpochTxCount()).toBe(0)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(log.getActiveEpochOpsCount()).toBe(1)
    expect(log.getActiveEpochTxCount()).toBe(1)

    log.emit([
      { kind: "set", path: [], key: "a", value: 2 },
      { kind: "set", path: [], key: "b", value: 3 },
    ])
    expect(log.getActiveEpochOpsCount()).toBe(3)
    expect(log.getActiveEpochTxCount()).toBe(2)

    log.emit([
      { kind: "set", path: [], key: "a", value: 4 },
      { kind: "set", path: [], key: "b", value: 5 },
      { kind: "set", path: [], key: "a", value: 6 },
    ])
    expect(log.getActiveEpochOpsCount()).toBe(6)
    expect(log.getActiveEpochTxCount()).toBe(3)

    // Compact and verify reset
    log.compact()
    expect(log.getActiveEpochOpsCount()).toBe(0)
    expect(log.getActiveEpochTxCount()).toBe(0)
    expect(log.getActiveEpoch()).toBe(1)

    log.dispose()
  })
})
