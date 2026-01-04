/**
 * Array-specific tests adapted from mutative's array.test.ts
 * Removed tests using mark feature (not supported)
 */

import { createOps, Draft, isDraft } from "../../src/createOps"

// Helper to adapt mutative's `create` API to our `createOps` API
function create<T extends object>(data: T, fn: (draft: Draft<T>) => void): T {
  const { nextState } = createOps(data, fn)
  return nextState
}

test("shift", () => {
  const obj = {
    a: Array.from({ length: 20 }, (_, i) => ({ i })),
    o: { b: { c: 1 } },
  }
  const state = create(obj, (draft) => {
    const a = draft.a.shift()!
    a.i++
    draft.a.push(a)
    expect(isDraft(a)).toBeTruthy()
  })
  // !!! check draft proxy array leakage
  expect(obj.a[0] === state.a.slice(-1)[0]).toBe(false)
})

test("splice", () => {
  const obj = {
    a: Array.from({ length: 20 }, (_, i) => ({ i })),
    o: { b: { c: 1 } },
  }
  const state = create(obj, (draft) => {
    const [a] = draft.a.splice(0, 1)!
    a.i++
    draft.a.push(a)
    expect(isDraft(a)).toBeTruthy()
  })
  // !!! check draft proxy array leakage
  expect(obj.a[0] === state.a.slice(-1)[0]).toBe(false)
})
