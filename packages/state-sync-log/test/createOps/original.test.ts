/**
 * original() tests adapted from mutative's original.test.ts
 * Removed tests using Map/Set features (not supported)
 */

import { createOps, Draft, isDraft, original } from "../../src/createOps"

// Helper to adapt mutative's `create` API to our `createOps` API
function create<T extends object>(data: T, fn: (draft: Draft<T>) => void): T {
  const { nextState } = createOps(data, fn)
  return nextState
}

describe("original", () => {
  test("should return the original value for objects and arrays", () => {
    interface Item {
      foo: string
      bar?: { foobar: string }
    }
    create(
      {
        arr: [{ foo: "bar" } as Item],
        obj: { foo: "bar" } as Item,
      },
      (draft) => {
        // Array item
        draft.arr[0].foo = "baz"
        expect(isDraft(draft.arr[0])).toBe(true)
        expect(original(draft.arr[0])).toEqual({ foo: "bar" })
        expect(() => original(draft.arr[0].bar!)).toThrow()

        // New props - not drafts
        draft.arr[0].bar = { foobar: "str" }
        draft.arr[0].bar.foobar = "baz"
        expect(isDraft(draft.arr[0].bar)).toBe(false)
        expect(() => original(draft.arr[0].bar)).toThrow()

        // Object
        draft.obj.foo = "baz"
        expect(isDraft(draft.obj)).toBe(true)
        expect(original(draft.obj)).toEqual({ foo: "bar" })

        // New props - not drafts
        draft.obj.bar = { foobar: "str" }
        draft.obj.bar!.foobar = "baz"
        expect(isDraft(draft.obj.bar)).toBe(false)
        expect(() => original(draft.obj.bar)).toThrow()
      }
    )
  })

  test("should throw for an object that is not proxied", () => {
    expect(() => original({})).toThrow(
      `original() is only used for a draft, parameter: [object Object]`
    )
    expect(() => original(3)).toThrow(`original() is only used for a draft, parameter: 3`)
  })
})
