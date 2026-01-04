/**
 * current() tests adapted from mutative's current.test.ts
 * Removed tests using Map/Set/mark features (not supported)
 */

import { createOps, current, Draft, isDraft } from "../../src/createOps"

// Helper to adapt mutative's `create` API to our `createOps` API
function create<T extends object>(data: T, fn: (draft: Draft<T>) => void): T {
  const { nextState } = createOps(data, fn)
  return nextState
}

describe("current", () => {
  test("base", () => {
    create({ a: { b: { c: 1 } }, d: { f: 1 } }, (draft) => {
      draft.a.b.c = 2
      expect(current(draft.a)).toEqual({ b: { c: 2 } })
      // The node `a` has been modified - new snapshot each time
      // biome-ignore lint/suspicious/noSelfCompare: testing reference equality
      expect(current(draft.a) === current(draft.a)).toBeFalsy()
      // The node `d` has not been modified - same reference
      // biome-ignore lint/suspicious/noSelfCompare: testing reference equality
      expect(current(draft.d) === current(draft.d)).toBeTruthy()
    })
  })

  test("should return the current value for objects", () => {
    interface Item {
      foo: string
      bar?: { foobar: string }
      data?: { foo: string }
    }
    create(
      {
        arr: [{ foo: "bar" } as Item],
        obj: { foo: "bar" } as Item,
        data: { foo: "bar" },
      },
      (draft) => {
        const { data } = draft

        // Array item modification
        draft.arr[0].foo = "baz"
        expect(isDraft(draft.arr[0])).toBe(true)
        expect(current(draft.arr[0])).toEqual({ foo: "baz" })

        draft.arr[0].bar = { foobar: "str" }
        draft.arr[0].bar.foobar = "baz"
        expect(isDraft(draft.arr[0].bar)).toBe(false)

        data.foo = "new str1"
        draft.arr[0].data = data
        expect(current(draft.arr[0])).toEqual({
          bar: { foobar: "baz" },
          data: { foo: "new str1" },
          foo: "baz",
        })

        // Object modification
        draft.obj.foo = "baz"
        expect(isDraft(draft.obj)).toBe(true)
        expect(current(draft.obj)).toEqual({ foo: "baz" })

        draft.obj.bar = { foobar: "str" }
        draft.obj.bar!.foobar = "baz"
        expect(isDraft(draft.obj.bar)).toBe(false)

        data.foo = "new str4"
        draft.obj.data = data
        expect(current(draft.obj)).toEqual({
          bar: { foobar: "baz" },
          data: { foo: "new str4" },
          foo: "baz",
        })
      }
    )
  })
})

test("nested draft", () => {
  type Data = {
    f: {
      f: {
        f: {
          a: number
        }
      }
    }
  }
  type State = {
    c: {
      a: number
    }
    d: {
      d: number | Data
    }
    j: {
      k: number
    }
  }
  const baseState: State = {
    c: {
      a: 1,
    },
    d: {
      d: 1,
    },
    j: {
      k: 1,
    },
  }
  create(baseState, (draft) => {
    draft.c.a = 2
    draft.d.d = {
      f: {
        f: {
          f: draft.c,
        },
      },
    }
    const d = current(draft.d)
    expect((d.d as Data).f.f.f).toEqual({ a: 2 })
    expect(isDraft((d.d as Data).f.f.f)).toBeFalsy()

    // the node `d` has been changed
    // biome-ignore lint/suspicious/noSelfCompare: testing reference equality
    expect(current(draft.d) === current(draft.d)).toBeFalsy()
    // the node `j` has not been changed
    // biome-ignore lint/suspicious/noSelfCompare: testing reference equality
    expect(current(draft.j) === current(draft.j)).toBeTruthy()
  })
})

test("#47 current creates new copies of the objects where unnecessary", () => {
  const obj = { k: 42 }
  const original = { x: { y: { z: [obj] } } }
  const yReplace = { z: [obj] }

  const withCreate = create(original, (draft) => {
    draft.x.y = yReplace
  })
  expect(withCreate.x.y === yReplace).toBe(true)
  expect(withCreate.x.y.z[0] === obj).toBe(true)
})

test("Avoid deep copies", () => {
  const obj = { k: 42 }
  const base = { x: { y: { z: obj } }, a: { c: 1 } } as any
  create(base, (draft) => {
    const a = draft.a
    a.c = 2
    delete draft.a
    draft.x1 = { y1: { z1: obj }, a }
    const c = current(draft)
    expect(c.x1.y1.z1).toBe(obj)
    expect(JSON.stringify(c)).toMatchInlineSnapshot(
      `"{"x":{"y":{"z":{"k":42}}},"x1":{"y1":{"z1":{"k":42}},"a":{"c":2}}}"`
    )
  })
})

test("nested create() - Avoid deep copies", () => {
  const obj = { k: 42 }
  const base = { x: { y: { z: obj } }, a: { c: 1 } } as any
  const base0 = { x: { y: { z: obj } }, a: { c: 1 } } as any
  create(base0, (draft0) => {
    const a = draft0.a
    a.c = 2
    delete draft0.a
    create(base, (draft) => {
      draft.x1 = { y1: { z1: obj }, a }
      const c = current(draft)
      expect(c.x1.y1.z1).toBe(obj)
      expect(JSON.stringify(c)).toMatchInlineSnapshot(
        `"{"x":{"y":{"z":{"k":42}}},"a":{"c":1},"x1":{"y1":{"z1":{"k":42}},"a":{"c":2}}}"`
      )
    })
  })
})
