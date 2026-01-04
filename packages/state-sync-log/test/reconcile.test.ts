import { describe, expect, it, vi } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog } from "../src/index"
import { computeReconcileOps } from "../src/reconcile"

describe("Reconcile", () => {
  it("reconciles state via diffs", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    log.reconcileState({ a: 1, b: 2 })
    expect(log.getState()).toStrictEqual({ a: 1, b: 2 })

    log.reconcileState({ a: 1, b: 3, c: 4 })
    expect(log.getState()).toStrictEqual({ a: 1, b: 3, c: 4 })
  })

  it("reconciles deeply nested state correctly", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    const target = {
      level1: {
        level2: {
          level3: {
            value: "deep",
            array: [1, 2, 3],
          },
        },
      },
    }

    log.reconcileState(target)
    expect(log.getState()).toStrictEqual(target)

    const updated = {
      level1: {
        level2: {
          level3: {
            value: "deeper",
            array: [1, 2, 3, 4],
          },
        },
      },
    }

    log.reconcileState(updated)
    expect(log.getState()).toStrictEqual(updated)
  })

  it("reconcile handles array shrinking", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    log.reconcileState({ arr: [1, 2, 3, 4, 5] })
    expect(log.getState().arr).toStrictEqual([1, 2, 3, 4, 5])

    log.reconcileState({ arr: [1, 2] })
    expect(log.getState().arr).toStrictEqual([1, 2])
  })

  it("reconcile handles array growing", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    log.reconcileState({ arr: [1, 2] })
    expect(log.getState().arr).toStrictEqual([1, 2])

    log.reconcileState({ arr: [1, 2, 3, 4, 5] })
    expect(log.getState().arr).toStrictEqual([1, 2, 3, 4, 5])
  })

  it("reconcile handles primitive value changes", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    log.reconcileState({ num: 1, str: "hello", bool: true, nil: null })
    expect(log.getState()).toStrictEqual({ num: 1, str: "hello", bool: true, nil: null })

    log.reconcileState({ num: 2, str: "world", bool: false, nil: null })
    expect(log.getState()).toStrictEqual({ num: 2, str: "world", bool: false, nil: null })
  })

  it("reconcile handles key deletion", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

    log.reconcileState({ a: 1, b: 2, c: 3 })
    expect(log.getState()).toStrictEqual({ a: 1, b: 2, c: 3 })

    log.reconcileState({ a: 1 })
    expect(log.getState()).toStrictEqual({ a: 1 })
  })

  it("reconcile is idempotent", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })
    const spy = vi.fn()
    log.subscribe(spy)

    const state = { x: 1, y: [1, 2, 3], z: { nested: true } }

    log.reconcileState(state)
    expect(log.getState()).toStrictEqual(state)
    expect(spy).toHaveBeenCalledTimes(1)

    // Reconciling same state should produce no ops and not trigger subscriber
    log.reconcileState(state)
    expect(log.getState()).toStrictEqual(state)
    expect(spy).toHaveBeenCalledTimes(1) // Still only 1 call
  })

  it("handles changing root type (should fail)", () => {
    // This hits emitReplace with empty path
    const current = { a: 1 }
    const target = [1]

    // computeReconcileOps catches this? No, it pushes ops.
    // emitReplace calls failure in this case.
    // So computeReconcileOps should revert/throw.
    expect(() => computeReconcileOps(current, target)).toThrow(/Cannot replace root state directly/)
  })

  it("short-circuits on identical object reference", () => {
    const obj = { a: 1 }
    const ops = computeReconcileOps(obj, obj)
    expect(ops).toStrictEqual([])
  })

  describe("undefined property support", () => {
    it("generates set op for undefined value (not delete)", () => {
      const current = { a: 1, b: 2 }
      const target = { a: 1, b: undefined }

      const ops = computeReconcileOps(current, target)

      expect(ops).toHaveLength(1)
      expect(ops[0]).toEqual({ kind: "set", path: [], key: "b", value: undefined })
    })

    it("generates delete op when property is actually removed", () => {
      const current = { a: 1, b: undefined }
      const target = { a: 1 }

      const ops = computeReconcileOps(current, target)

      expect(ops).toHaveLength(1)
      expect(ops[0]).toEqual({ kind: "delete", path: [], key: "b" })
    })

    it("setting property to undefined preserves property in state", () => {
      const doc = new SyncLogDoc()
      const log = createStateSyncLog<any>({
        syncLogDoc: doc,
        retentionWindowMs: undefined,
      })

      log.reconcileState({ a: 1, b: 2 })
      log.reconcileState({ a: 1, b: undefined })

      const state = log.getState()
      expect("b" in state).toBe(true)
      expect(state.b).toBe(undefined)
      expect(Object.keys(state)).toEqual(["a", "b"])
    })

    it("deleting property removes it from state", () => {
      const doc = new SyncLogDoc()
      const log = createStateSyncLog<any>({
        syncLogDoc: doc,
        retentionWindowMs: undefined,
      })

      log.reconcileState({ a: 1, b: undefined })
      expect("b" in log.getState()).toBe(true)

      log.reconcileState({ a: 1 })

      const state = log.getState()
      expect("b" in state).toBe(false)
      expect(Object.keys(state)).toEqual(["a"])
    })

    it("emit set operation with undefined value", () => {
      const doc = new SyncLogDoc()
      const log = createStateSyncLog<any>({
        syncLogDoc: doc,
        retentionWindowMs: undefined,
      })

      log.reconcileState({ a: 1, b: 2 })
      log.emit([{ kind: "set", path: [], key: "b", value: undefined }])

      const state = log.getState()
      expect("b" in state).toBe(true)
      expect(state.b).toBe(undefined)
    })

    it("emit set operation with array containing undefined", () => {
      const doc = new SyncLogDoc()
      const log = createStateSyncLog<any>({
        syncLogDoc: doc,
        retentionWindowMs: undefined,
      })

      log.reconcileState({ arr: [1, 2, 3] })
      log.emit([{ kind: "set", path: [], key: "arr", value: [1, undefined, 3] }])

      const state = log.getState()
      expect(state.arr).toHaveLength(3)
      expect(state.arr[0]).toBe(1)
      expect(state.arr[1]).toBe(undefined)
      expect(state.arr[2]).toBe(3)
      expect(1 in state.arr).toBe(true) // index 1 exists (not a sparse hole)
    })

    it("reconcile with array containing undefined", () => {
      const doc = new SyncLogDoc()
      const log = createStateSyncLog<any>({
        syncLogDoc: doc,
        retentionWindowMs: undefined,
      })

      log.reconcileState({ data: { arr: [1, undefined, 3] } })

      const state = log.getState()
      expect(state.data.arr[1]).toBe(undefined)
      expect(1 in state.data.arr).toBe(true)
    })
  })
})
