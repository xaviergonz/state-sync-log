import { describe, expect, it, vi } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog, getSortedTxsSymbol } from "../src/createStateSyncLog"

describe("Controller API", () => {
  it("initializes with empty state", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog({ syncLogDoc: doc, retentionWindowMs: undefined })
    expect(log.getState()).toStrictEqual({})
    expect(log.isLogEmpty()).toBe(true)
  })

  it("subscribes to changes", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })
    const spy = vi.fn()
    log.subscribe(spy)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])

    expect(spy).toHaveBeenCalledTimes(1)
    const [state, getAppliedOps] = spy.mock.lastCall!
    expect(state).toStrictEqual({ a: 1 })
    expect(getAppliedOps()).toStrictEqual([{ kind: "set", path: [], key: "a", value: 1 }])
  })

  it("unsubscribe stops callback from firing", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })
    const spy = vi.fn()

    const unsubscribe = log.subscribe(spy)
    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(spy).toHaveBeenCalledTimes(1)

    unsubscribe()

    log.emit([{ kind: "set", path: [], key: "b", value: 2 }])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("multiple subscribers all receive updates", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    const spy1 = vi.fn()
    const spy2 = vi.fn()
    const spy3 = vi.fn()

    log.subscribe(spy1)
    log.subscribe(spy2)
    log.subscribe(spy3)

    log.emit([{ kind: "set", path: [], key: "x", value: 1 }])

    expect(spy1).toHaveBeenCalledTimes(1)
    expect(spy2).toHaveBeenCalledTimes(1)
    expect(spy3).toHaveBeenCalledTimes(1)
  })

  it("disposes correctly and stops firing subscriptions", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })
    const spy = vi.fn()

    log.subscribe(spy)
    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(spy).toHaveBeenCalledTimes(1)

    log.dispose()

    // Double dispose should not throw (it's a no-op)
    expect(() => log.dispose()).not.toThrow()

    // All other methods should throw after disposal
    const errMsg = "StateSyncLog has been disposed"
    expect(() => log.getState()).toThrow(errMsg)
    expect(() => log.emit([{ kind: "set", path: [], key: "b", value: 2 }])).toThrow(errMsg)
    expect(() => log.reconcileState({ x: 1 })).toThrow(errMsg)
    expect(() => log.compact()).toThrow(errMsg)
    expect(() => log.subscribe(() => {})).toThrow(errMsg)
    expect(() => log.getActiveEpoch()).toThrow(errMsg)
    expect(() => log.getActiveEpochTxCount()).toThrow(errMsg)
    expect(() => log.getActiveEpochStartTime()).toThrow(errMsg)
    expect(() => log.isLogEmpty()).toThrow(errMsg)
    expect(() => log[getSortedTxsSymbol]()).toThrow(errMsg)
  })

  it("tracks getActiveEpochTxCount correctly", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    expect(log.getActiveEpochTxCount()).toBe(0)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(log.getActiveEpochTxCount()).toBeGreaterThan(0)
  })

  it("tracks getActiveEpochStartTime correctly", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    // Before any txs
    expect(log.getActiveEpochStartTime()).toBeUndefined()

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])

    // After emit, before compact - should have timestamp
    expect(log.getActiveEpochStartTime()).toBeDefined()
    expect(typeof log.getActiveEpochStartTime()).toBe("number")

    log.compact()

    // After compact - new epoch has no txs
    expect(log.getActiveEpochStartTime()).toBeUndefined()
  })

  it("handles empty emit array", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })
    const spy = vi.fn()

    log.subscribe(spy)
    log.emit([])

    // Empty emit SHOULD trigger subscriber now (with lazy ops)
    expect(spy).toHaveBeenCalled()
    const [_state, getAppliedOps] = spy.mock.lastCall!
    expect(getAppliedOps()).toStrictEqual([])
    expect(log.getState()).toStrictEqual({})
  })

  it("getActiveEpoch returns current epoch number", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    expect(log.getActiveEpoch()).toBe(0)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    log.compact()

    expect(log.getActiveEpoch()).toBe(1)
  })

  it("isLogEmpty returns true only when both tx and checkpoints are empty", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    expect(log.isLogEmpty()).toBe(true)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(log.isLogEmpty()).toBe(false)

    log.compact()
    expect(log.isLogEmpty()).toBe(false) // Checkpoint exists
  })

  it("passes origin to onUpdate callback when emit() is called", () => {
    const doc = new SyncLogDoc()
    const customOrigin = { source: "test-client" }
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      origin: customOrigin,
    })

    const updateSpy = vi.fn()
    doc.onUpdate(updateSpy)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [_update, receivedOrigin] = updateSpy.mock.lastCall!
    expect(receivedOrigin).toBe(customOrigin)
  })

  it("passes origin to onUpdate callback when compact() is called", () => {
    const doc = new SyncLogDoc()
    const customOrigin = { source: "test-checkpoint" }
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      origin: customOrigin,
    })

    const updateSpy = vi.fn()
    doc.onUpdate(updateSpy)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(updateSpy).toHaveBeenCalledTimes(1)

    log.compact()
    expect(updateSpy).toHaveBeenCalledTimes(2)
    const [_update, receivedOrigin] = updateSpy.mock.lastCall!
    expect(receivedOrigin).toBe(customOrigin)
  })

  it("origin is undefined when not provided", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    const updateSpy = vi.fn()
    doc.onUpdate(updateSpy)

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [_update, receivedOrigin] = updateSpy.mock.lastCall!
    expect(receivedOrigin).toBeUndefined()
  })

  it("can distinguish local vs remote updates using origin", () => {
    const docA = new SyncLogDoc()
    const docB = new SyncLogDoc()

    const localOriginA = Symbol("local-A")
    const localOriginB = Symbol("local-B")

    const logA = createStateSyncLog<any>({
      syncLogDoc: docA,
      retentionWindowMs: undefined,
      origin: localOriginA,
    })
    const logB = createStateSyncLog<any>({
      syncLogDoc: docB,
      retentionWindowMs: undefined,
      origin: localOriginB,
    })

    const originsA: unknown[] = []
    const originsB: unknown[] = []

    // Subscribe to doc-level updates to see origins
    docA.onUpdate((_update, origin) => originsA.push(origin))
    docB.onUpdate((_update, origin) => originsB.push(origin))

    // A emits locally - origin should be localOriginA
    logA.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    expect(originsA).toStrictEqual([localOriginA])

    // Sync from A to B using delta sync
    const svB = docB.getStateVector()
    const update = docA.encodeStateAsUpdate(svB)
    docB.applyUpdate(update) // No origin passed - treated as remote

    // B should see undefined origin for the remote update
    expect(originsB.length).toBe(1)
    expect(originsB[0]).toBeUndefined()

    // B emits locally - origin should be localOriginB
    logB.emit([{ kind: "set", path: [], key: "b", value: 2 }])
    expect(originsB).toStrictEqual([undefined, localOriginB])
  })
})
