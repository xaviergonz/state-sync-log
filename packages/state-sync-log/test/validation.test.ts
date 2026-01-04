import { describe, expect, it } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog } from "../src/index"

describe("Validation", () => {
  it("validates state changes", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
      validate: (state) => typeof state.count === "number" && state.count >= 0,
    })

    log.emit([{ kind: "set", path: [], key: "count", value: 10 }])
    expect(log.getState()).toStrictEqual({ count: 10 })

    // Invalid op should be rejected (state remains same)
    log.emit([{ kind: "set", path: [], key: "count", value: -5 }])
    expect(log.getState()).toStrictEqual({ count: 10 })
  })

  it("rejects operations targeting non-existent paths", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
    })

    log.emit([{ kind: "set", path: ["nonexistent"], key: "foo", value: 1 }])
    expect(log.getState()).toStrictEqual({})
  })

  it("allows set operation on array container (by index or property)", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
    })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    log.emit([{ kind: "set", path: ["arr"], key: 1, value: 99 }])

    expect(log.getState().arr).toStrictEqual([1, 99, 3])
  })

  it("allows delete operation on array container (creates sparse hole)", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
    })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    log.emit([{ kind: "delete", path: ["arr"], key: 0 }])

    // Delete creates a sparse array with hole at index 0
    const arr = log.getState().arr
    expect(arr.length).toBe(3)
    expect(0 in arr).toBe(false) // Hole at index 0
    expect(arr[1]).toBe(2)
    expect(arr[2]).toBe(3)
  })

  it("rejects splice operation on object container", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
    })

    log.emit([{ kind: "set", path: [], key: "obj", value: { a: 1 } }])
    log.emit([{ kind: "splice", path: ["obj"], index: 0, deleteCount: 1, inserts: [] }])

    expect(log.getState().obj).toStrictEqual({ a: 1 })
  })

  it("rejects addToSet operation on object container", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
    })

    log.emit([{ kind: "set", path: [], key: "obj", value: { a: 1 } }])
    log.emit([{ kind: "addToSet", path: ["obj"], value: "new" }])

    expect(log.getState().obj).toStrictEqual({ a: 1 })
  })

  it("rejects deleteFromSet operation on object container", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
    })

    log.emit([{ kind: "set", path: [], key: "obj", value: { a: 1 } }])
    log.emit([{ kind: "deleteFromSet", path: ["obj"], value: "a" }])

    expect(log.getState().obj).toStrictEqual({ a: 1 })
  })

  it("partial tx failure rejects entire tx", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
    })

    log.emit([{ kind: "set", path: [], key: "a", value: 1 }])

    log.emit([
      { kind: "set", path: [], key: "b", value: 2 },
      { kind: "set", path: ["nonexistent"], key: "c", value: 3 },
    ])

    expect(log.getState()).toStrictEqual({ a: 1 })
  })

  it("throws if clientId contains a semicolon", () => {
    const doc = new SyncLogDoc()
    expect(() =>
      createStateSyncLog({
        syncLogDoc: doc,
        clientId: "user;1",
        retentionWindowMs: undefined,
        autoCompact: () => false,
      })
    ).toThrow("clientId MUST NOT contain semicolons")
  })

  it("handles validation function that throws", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
      autoCompact: () => false,
      validate: (state) => {
        if (state.trigger === "error") {
          throw new Error("Validation exploded!")
        }
        return true
      },
    })

    log.emit([{ kind: "set", path: [], key: "safe", value: 1 }])
    expect(log.getState()).toStrictEqual({ safe: 1 })

    // This should not throw but reject the tx
    log.emit([{ kind: "set", path: [], key: "trigger", value: "error" }])
    expect(log.getState()).toStrictEqual({ safe: 1 }) // State unchanged
  })
})
