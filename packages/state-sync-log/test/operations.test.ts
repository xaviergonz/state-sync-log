import { describe, expect, it } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { applyOps, createStateSyncLog, type Op } from "../src/index"

describe("Operations", () => {
  it("handles basic set operations", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "count", value: 1 }])
    expect(log.getState()).toStrictEqual({ count: 1 })
    expect(log.isLogEmpty()).toBe(false)
  })

  it("handles nested updates", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "user", value: { name: "Alice", age: 30 } }])
    expect(log.getState()).toStrictEqual({ user: { name: "Alice", age: 30 } })

    log.emit([{ kind: "set", path: ["user"], key: "age", value: 31 }])
    expect(log.getState()).toStrictEqual({ user: { name: "Alice", age: 31 } })
  })

  it("handles deletion", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "temp", value: "foo" }])
    expect(log.getState()).toStrictEqual({ temp: "foo" })

    log.emit([{ kind: "delete", path: [], key: "temp" }])
    expect(log.getState()).toStrictEqual({})
  })

  it("handles array splice", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "list", value: [1, 2, 3] }])
    expect(log.getState()).toStrictEqual({ list: [1, 2, 3] })

    log.emit([{ kind: "splice", path: ["list"], index: 1, deleteCount: 1, inserts: [4, 5] }])
    expect(log.getState()).toStrictEqual({ list: [1, 4, 5, 3] })
  })

  it("handles addToSet / deleteFromSet", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "tags", value: [] }])

    log.emit([{ kind: "addToSet", path: ["tags"], value: "red" }])
    expect(log.getState().tags).toStrictEqual(["red"])

    // Duplicate add should be ignored
    log.emit([{ kind: "addToSet", path: ["tags"], value: "red" }])
    expect(log.getState().tags).toStrictEqual(["red"])

    log.emit([{ kind: "addToSet", path: ["tags"], value: "blue" }])
    expect(log.getState().tags).toStrictEqual(["red", "blue"])

    log.emit([{ kind: "deleteFromSet", path: ["tags"], value: "red" }])
    expect(log.getState().tags).toStrictEqual(["blue"])
  })

  it("deleteFromSet removes all matching items", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: ["a", "b", "a", "c", "a"] }])
    log.emit([{ kind: "deleteFromSet", path: ["arr"], value: "a" }])

    expect(log.getState().arr).toStrictEqual(["b", "c"])
  })

  it("handles array path segments with numeric index", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([
      { kind: "set", path: [], key: "arr", value: [{ name: "first" }, { name: "second" }] },
    ])

    log.emit([{ kind: "set", path: ["arr", 1], key: "name", value: "updated" }])
    expect(log.getState().arr[1].name).toBe("updated")
  })

  it("handles splice with out-of-bounds index safely", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    log.emit([{ kind: "splice", path: ["arr"], index: 100, deleteCount: 0, inserts: [4] }])

    expect(log.getState().arr).toStrictEqual([1, 2, 3, 4])
  })

  it("handles negative splice index", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    log.emit([{ kind: "splice", path: ["arr"], index: -1, deleteCount: 0, inserts: [99] }])

    // JavaScript splice with -1 inserts before last element
    expect(log.getState().arr).toStrictEqual([1, 2, 99, 3])
  })

  it("handles complex objects as addToSet values", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "items", value: [] }])
    log.emit([{ kind: "addToSet", path: ["items"], value: { id: 1, name: "first" } }])
    log.emit([{ kind: "addToSet", path: ["items"], value: { id: 2, name: "second" } }])

    // Duplicate should be ignored (deep equality)
    log.emit([{ kind: "addToSet", path: ["items"], value: { id: 1, name: "first" } }])

    expect(log.getState().items).toStrictEqual([
      { id: 1, name: "first" },
      { id: 2, name: "second" },
    ])
  })

  it("deleteFromSet with complex objects uses deep equality", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([
      {
        kind: "set",
        path: [],
        key: "items",
        value: [
          { id: 1, name: "first" },
          { id: 2, name: "second" },
          { id: 1, name: "first" },
        ],
      },
    ])

    log.emit([{ kind: "deleteFromSet", path: ["items"], value: { id: 1, name: "first" } }])

    expect(log.getState().items).toStrictEqual([{ id: 2, name: "second" }])
  })

  it("applies multiple operations in a single tx atomically", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([
      { kind: "set", path: [], key: "a", value: 1 },
      { kind: "set", path: [], key: "b", value: 2 },
      { kind: "set", path: [], key: "c", value: 3 },
    ])

    expect(log.getState()).toStrictEqual({ a: 1, b: 2, c: 3 })
  })

  it("handles splice with excessive deleteCount (clamped to available)", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: [1, 2, 3] }])
    // deleteCount=100 should only delete remaining elements (3 - index 1 = 2 elements)
    log.emit([{ kind: "splice", path: ["arr"], index: 1, deleteCount: 100, inserts: [99] }])

    expect(log.getState().arr).toStrictEqual([1, 99])
  })

  it("deleteFromSet on non-existing value is a no-op", () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({ syncLogDoc: doc, retentionWindowMs: undefined })

    log.emit([{ kind: "set", path: [], key: "arr", value: ["a", "b", "c"] }])
    log.emit([{ kind: "deleteFromSet", path: ["arr"], value: "nonexistent" }])

    expect(log.getState().arr).toStrictEqual(["a", "b", "c"])
  })
})

describe("applyOps", () => {
  it("clones values by default", () => {
    const target: any = {}
    const valueToSet = { nested: { deep: 1 } }
    const ops: Op[] = [{ kind: "set", path: [], key: "x", value: valueToSet }]

    applyOps(ops, target)

    // Value should be cloned
    expect(target.x).not.toBe(valueToSet)
    expect(target.x.nested).not.toBe(valueToSet.nested)
    expect(target.x).toStrictEqual(valueToSet)
  })

  it("clones values when cloneValues is true", () => {
    const target: any = {}
    const valueToSet = { nested: { deep: 1 } }
    const ops: Op[] = [{ kind: "set", path: [], key: "x", value: valueToSet }]

    applyOps(ops, target, { cloneValues: true })

    // Value should be cloned
    expect(target.x).not.toBe(valueToSet)
    expect(target.x).toStrictEqual(valueToSet)
  })

  it("uses values directly when cloneValues is false", () => {
    const target: any = {}
    const valueToSet = { nested: { deep: 1 } }
    const ops: Op[] = [{ kind: "set", path: [], key: "x", value: valueToSet }]

    applyOps(ops, target, { cloneValues: false })

    // Value should be used directly (same reference)
    expect(target.x).toBe(valueToSet)
    expect(target.x.nested).toBe(valueToSet.nested)
  })

  it("clones splice inserts by default", () => {
    const target: any = { arr: [] }
    const objToInsert = { id: 1 }
    const ops: Op[] = [
      { kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [objToInsert] },
    ]

    applyOps(ops, target)

    expect(target.arr[0]).not.toBe(objToInsert)
    expect(target.arr[0]).toStrictEqual(objToInsert)
  })

  it("uses splice inserts directly when cloneValues is false", () => {
    const target: any = { arr: [] }
    const objToInsert = { id: 1 }
    const ops: Op[] = [
      { kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [objToInsert] },
    ]

    applyOps(ops, target, { cloneValues: false })

    expect(target.arr[0]).toBe(objToInsert)
  })

  it("clones addToSet values by default", () => {
    const target: any = { set: [] }
    const objToAdd = { id: 1 }
    const ops: Op[] = [{ kind: "addToSet", path: ["set"], value: objToAdd }]

    applyOps(ops, target)

    expect(target.set[0]).not.toBe(objToAdd)
    expect(target.set[0]).toStrictEqual(objToAdd)
  })

  it("uses addToSet values directly when cloneValues is false", () => {
    const target: any = { set: [] }
    const objToAdd = { id: 1 }
    const ops: Op[] = [{ kind: "addToSet", path: ["set"], value: objToAdd }]

    applyOps(ops, target, { cloneValues: false })

    expect(target.set[0]).toBe(objToAdd)
  })
})

describe("applyOps validation", () => {
  it("allows setting on array (index or length)", () => {
    const target: any = { arr: [1, 2, 3] }
    const ops: Op[] = [{ kind: "set", path: ["arr"], key: 1, value: 99 }]
    applyOps(ops, target)
    expect(target.arr[1]).toBe(99)
  })

  it("allows deleting from array", () => {
    const target: any = { arr: [1, 2, 3] }
    const ops: Op[] = [{ kind: "delete", path: ["arr"], key: 1 }]
    applyOps(ops, target)
    expect(target.arr[1]).toBeUndefined()
  })

  it("sets array length to truncate", () => {
    const target: any = { arr: [1, 2, 3, 4, 5] }
    const ops: Op[] = [{ kind: "set", path: ["arr"], key: "length", value: 2 }]
    applyOps(ops, target)
    expect(target.arr).toEqual([1, 2])
  })

  it("sets array length to expand", () => {
    const target: any = { arr: [1, 2] }
    const ops: Op[] = [{ kind: "set", path: ["arr"], key: "length", value: 4 }]
    applyOps(ops, target)
    expect(target.arr.length).toBe(4)
    expect(target.arr[2]).toBeUndefined()
    expect(target.arr[3]).toBeUndefined()
  })

  it("sets nested array element", () => {
    const target: any = { outer: { arr: [{ a: 1 }, { a: 2 }] } }
    const ops: Op[] = [{ kind: "set", path: ["outer", "arr"], key: 0, value: { a: 99 } }]
    applyOps(ops, target)
    expect(target.outer.arr[0]).toEqual({ a: 99 })
  })

  it("throws when splicing non-array", () => {
    const target: any = { obj: {} }
    const ops: Op[] = [{ kind: "splice", path: ["obj"], index: 0, deleteCount: 0, inserts: [] }]
    expect(() => applyOps(ops, target)).toThrow(/splice requires array container/)
  })

  it("throws when adding to set on non-array", () => {
    const target: any = { obj: {} }
    const ops: any[] = [{ kind: "addToSet", path: ["obj"], value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/addToSet requires array container/)
  })

  it("throws when deleting from set on non-array", () => {
    const target: any = { obj: {} }
    const ops: any[] = [{ kind: "deleteFromSet", path: ["obj"], value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/deleteFromSet requires array container/)
  })

  it("throws on unknown op kind", () => {
    const target: any = {}
    const ops: any[] = [{ kind: "unknown", path: [], key: "a" }]
    expect(() => applyOps(ops, target)).toThrow(/Unknown operation kind/)
  })

  it("throws when path segment is string for array container", () => {
    const target: any = { arr: [] }
    const ops: Op[] = [{ kind: "set", path: ["arr", "key"], key: "val", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/Expected object at path segment "key"/)
  })

  it("throws when path property does not exist", () => {
    const target: any = { obj: {} }
    const ops: Op[] = [{ kind: "set", path: ["obj", "missing", "key"], key: "val", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/Property "missing" does not exist/)
  })

  it("throws when path segment is number for object container", () => {
    const target: any = { obj: {} }
    const ops: any[] = [{ kind: "set", path: ["obj", 0], key: "val", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/Expected array at path segment 0/)
  })

  it("throws when path index is out of bounds", () => {
    const target: any = { arr: [1] }
    const ops: any[] = [{ kind: "set", path: ["arr", 5], key: "val", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(/Index 5 out of bounds/)
  })

  it("throws when setting non-numeric property on array", () => {
    const target: any = { arr: [] }
    const ops: Op[] = [{ kind: "set", path: ["arr"], key: "someKey", value: 1 }]
    expect(() => applyOps(ops, target)).toThrow(
      /Cannot set non-numeric property "someKey" on array/
    )
  })

  it("throws when deleting non-numeric property from array", () => {
    const target: any = { arr: [] }
    const ops: Op[] = [{ kind: "delete", path: ["arr"], key: "someKey" }]
    expect(() => applyOps(ops, target)).toThrow(
      /Cannot delete non-numeric property "someKey" from array/
    )
  })

  it("allows setting length property on array", () => {
    const target: any = { arr: [1, 2, 3] }
    const ops: Op[] = [{ kind: "set", path: ["arr"], key: "length", value: 1 }]
    applyOps(ops, target)
    expect(target.arr).toEqual([1])
    expect(target.arr.length).toBe(1)
  })

  it("allows setting numeric index on array", () => {
    const target: any = { arr: [1, 2, 3] }
    const ops: Op[] = [{ kind: "set", path: ["arr"], key: 1, value: 99 }]
    applyOps(ops, target)
    expect(target.arr).toEqual([1, 99, 3])
  })

  it("allows deleting numeric index from array", () => {
    const target: any = { arr: [1, 2, 3] }
    const ops: Op[] = [{ kind: "delete", path: ["arr"], key: 1 }]
    applyOps(ops, target)
    // Sparse array - index 1 is deleted but length remains 3
    expect(target.arr.length).toBe(3)
    expect(1 in target.arr).toBe(false)
  })
})

describe("applyOps success features", () => {
  it("applies delete operation", () => {
    const target: any = { a: 1, b: 2 }
    applyOps([{ kind: "delete", path: [], key: "a" }], target)
    expect(target).toStrictEqual({ b: 2 })
    expect(target.a).toBeUndefined()
  })

  it("applies deleteFromSet operation", () => {
    const target: any = { arr: ["a", "b", "a"] }
    applyOps([{ kind: "deleteFromSet", path: ["arr"], value: "a" }], target)
    expect(target.arr).toStrictEqual(["b"])
  })

  it("applies splice operation (delete)", () => {
    const target: any = { arr: [1, 2, 3] }
    applyOps([{ kind: "splice", path: ["arr"], index: 1, deleteCount: 1, inserts: [] }], target)
    expect(target.arr).toStrictEqual([1, 3])
  })
})

describe("set undefined vs delete distinction", () => {
  it("set with undefined value keeps the key in state", () => {
    const target: any = { a: 1, b: 2 }
    applyOps([{ kind: "set", path: [], key: "b", value: undefined }], target)
    expect("b" in target).toBe(true)
    expect(target.b).toBe(undefined)
    expect(Object.keys(target)).toEqual(["a", "b"])
  })

  it("delete removes the key from state", () => {
    const target: any = { a: 1, b: 2 }
    applyOps([{ kind: "delete", path: [], key: "b" }], target)
    expect("b" in target).toBe(false)
    expect(target.b).toBe(undefined)
    expect(Object.keys(target)).toEqual(["a"])
  })

  it("set undefined and delete produce different results", () => {
    const target1: any = { a: 1, b: 2 }
    const target2: any = { a: 1, b: 2 }

    applyOps([{ kind: "set", path: [], key: "b", value: undefined }], target1)
    applyOps([{ kind: "delete", path: [], key: "b" }], target2)

    // Both targets have b as undefined when accessed
    expect(target1.b).toBe(undefined)
    expect(target2.b).toBe(undefined)

    // But they are structurally different
    expect("b" in target1).toBe(true)
    expect("b" in target2).toBe(false)
    expect(Object.keys(target1)).not.toEqual(Object.keys(target2))
  })

  it("handles set undefined in nested objects", () => {
    const target: any = { obj: { a: 1, b: 2 } }
    applyOps([{ kind: "set", path: ["obj"], key: "b", value: undefined }], target)
    expect("b" in target.obj).toBe(true)
    expect(target.obj.b).toBe(undefined)
  })

  it("handles delete in nested objects", () => {
    const target: any = { obj: { a: 1, b: 2 } }
    applyOps([{ kind: "delete", path: ["obj"], key: "b" }], target)
    expect("b" in target.obj).toBe(false)
  })

  it("handles set undefined in arrays (keeps the index)", () => {
    const target: any = { arr: [1, 2, 3] }
    applyOps([{ kind: "set", path: ["arr"], key: 1, value: undefined }], target)
    expect(target.arr.length).toBe(3)
    expect(1 in target.arr).toBe(true)
    expect(target.arr[1]).toBe(undefined)
    expect(target.arr).toStrictEqual([1, undefined, 3])
  })

  it("handles delete on array index (creates sparse array)", () => {
    const target: any = { arr: [1, 2, 3] }
    applyOps([{ kind: "delete", path: ["arr"], key: 1 }], target)
    // Delete on array creates a sparse array (hole)
    expect(target.arr.length).toBe(3)
    expect(1 in target.arr).toBe(false)
    expect(target.arr[1]).toBe(undefined)
  })

  it("set undefined in array vs delete in array are different", () => {
    const target1: any = { arr: [1, 2, 3] }
    const target2: any = { arr: [1, 2, 3] }

    applyOps([{ kind: "set", path: ["arr"], key: 1, value: undefined }], target1)
    applyOps([{ kind: "delete", path: ["arr"], key: 1 }], target2)

    // Both have undefined at index 1
    expect(target1.arr[1]).toBe(undefined)
    expect(target2.arr[1]).toBe(undefined)

    // But structurally different (sparse vs explicit undefined)
    expect(1 in target1.arr).toBe(true)
    expect(1 in target2.arr).toBe(false)
  })
})
