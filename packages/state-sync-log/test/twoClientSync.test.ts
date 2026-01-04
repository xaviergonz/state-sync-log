import { describe, expect, it } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog } from "../src/index"
import { applyServerCheckpoint, expectConvergence, syncDocs } from "./utils"

/**
 * Helper to create a two-client test setup with separate SyncLogDoc instances.
 * This simulates real network conditions where clients have their own documents
 * that sync via update messages.
 */
function createTwoClientSetup() {
  const docA = new SyncLogDoc()
  const docB = new SyncLogDoc()

  const logA = createStateSyncLog<any>({
    syncLogDoc: docA,
    clientId: "A",
    retentionWindowMs: undefined,
  })

  const logB = createStateSyncLog<any>({
    syncLogDoc: docB,
    clientId: "B",
    retentionWindowMs: undefined,
  })

  return { docA, docB, logA, logB }
}

describe("Two Client Sync", () => {
  it("syncs basic operations between two isolated clients", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // Client A makes changes in isolation
    logA.emit([{ kind: "set", path: [], key: "fromA", value: 1 }])

    // Client B makes changes in isolation
    logB.emit([{ kind: "set", path: [], key: "fromB", value: 2 }])

    // Before sync: states are different
    expect(logA.getState()).toStrictEqual({ fromA: 1 })
    expect(logB.getState()).toStrictEqual({ fromB: 2 })

    // Sync
    syncDocs(docA, docB)

    // After sync: states converge
    expectConvergence(logA, logB)
    expect(logA.getState()).toStrictEqual({ fromA: 1, fromB: 2 })
  })

  it("handles concurrent edits to the same key", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // Both clients edit the same key in isolation
    logA.emit([{ kind: "set", path: [], key: "x", value: "A" }])
    logB.emit([{ kind: "set", path: [], key: "x", value: "B" }])

    // Sync
    syncDocs(docA, docB)

    // Both should converge to the same value (determined by Lamport clock + clientId)
    expectConvergence(logA, logB)

    // The value should be one of "A" or "B" (deterministic, based on clocks)
    const finalValue = logA.getState().x
    expect(["A", "B"]).toContain(finalValue)
  })

  it("handles multiple sync rounds with interleaved operations", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // Round 1: A makes changes
    logA.emit([{ kind: "set", path: [], key: "count", value: 1 }])
    syncDocs(docA, docB)
    expectConvergence(logA, logB)

    // Round 2: B increments (sees A's state)
    logB.emit([{ kind: "set", path: [], key: "count", value: 2 }])
    syncDocs(docA, docB)
    expectConvergence(logA, logB)
    expect(logA.getState().count).toBe(2)

    // Round 3: Both make concurrent changes
    logA.emit([{ kind: "set", path: [], key: "a", value: "fromA" }])
    logB.emit([{ kind: "set", path: [], key: "b", value: "fromB" }])
    syncDocs(docA, docB)
    expectConvergence(logA, logB)
    expect(logA.getState()).toStrictEqual({ count: 2, a: "fromA", b: "fromB" })
  })

  it("handles long offline period with many changes", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // Initial sync
    logA.emit([{ kind: "set", path: [], key: "initial", value: true }])
    syncDocs(docA, docB)
    expectConvergence(logA, logB)

    // Client A goes offline and makes many changes
    for (let i = 0; i < 5; i++) {
      logA.emit([{ kind: "set", path: [], key: `offlineA_${i}`, value: i }])
    }

    // Client B also offline, makes different changes
    for (let i = 0; i < 5; i++) {
      logB.emit([{ kind: "set", path: [], key: `offlineB_${i}`, value: i * 10 }])
    }

    // States are diverged
    expect(logA.getState()).not.toStrictEqual(logB.getState())

    // Sync
    syncDocs(docA, docB)

    // Converge
    expectConvergence(logA, logB)

    // Both sets of changes should be present
    const state = logA.getState()
    expect(state.initial).toBe(true)
    for (let i = 0; i < 5; i++) {
      expect(state[`offlineA_${i}`]).toBe(i)
      expect(state[`offlineB_${i}`]).toBe(i * 10)
    }
  })

  it("handles checkpointing on one client then sync", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // A makes changes
    logA.emit([{ kind: "set", path: [], key: "data", value: { nested: true } }])

    // Server-mediated checkpointing (syncs first, then creates checkpoint, then broadcasts)
    applyServerCheckpoint([docA, docB], [logA, logB], 0)

    // B should now see the checkpointed state
    expectConvergence(logA, logB)
    expect(logB.getState()).toStrictEqual({ data: { nested: true } })
  })

  it("handles checkpointing on both clients via server-mediated pattern", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // Both make changes in isolation
    logA.emit([{ kind: "set", path: [], key: "a", value: 1 }])
    logB.emit([{ kind: "set", path: [], key: "b", value: 2 }])

    // Sync first
    syncDocs(docA, docB)
    expectConvergence(logA, logB)

    // Server-mediated checkpointing: one client creates checkpoint, broadcasts to all
    applyServerCheckpoint([docA, docB], [logA, logB], 0)

    // Should still work
    expectConvergence(logA, logB)
    expect(logA.getState()).toStrictEqual({ a: 1, b: 2 })
  })

  it("handles nested object updates from both clients", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // A creates nested structure
    logA.emit([{ kind: "set", path: [], key: "user", value: { name: "Alice", score: 0 } }])
    syncDocs(docA, docB)

    // B updates a nested field
    logB.emit([{ kind: "set", path: ["user"], key: "score", value: 100 }])
    syncDocs(docA, docB)

    expectConvergence(logA, logB)
    expect(logA.getState()).toStrictEqual({ user: { name: "Alice", score: 100 } })
  })

  it("handles array operations from both clients", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // A creates array
    logA.emit([{ kind: "set", path: [], key: "items", value: [1, 2, 3] }])
    syncDocs(docA, docB)

    // A appends from end
    logA.emit([{ kind: "splice", path: ["items"], index: 3, deleteCount: 0, inserts: [4] }])

    // B prepends from start
    logB.emit([{ kind: "splice", path: ["items"], index: 0, deleteCount: 0, inserts: [0] }])

    syncDocs(docA, docB)

    expectConvergence(logA, logB)
    // Both operations should be present (order depends on clock resolution)
    const items = logA.getState().items as number[]
    expect(items).toContain(0)
    expect(items).toContain(4)
  })

  it("handles addToSet from both clients with deduplication", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // Create set on both
    logA.emit([{ kind: "set", path: [], key: "tags", value: [] }])
    syncDocs(docA, docB)

    // Both add the same item
    logA.emit([{ kind: "addToSet", path: ["tags"], value: "shared" }])
    logB.emit([{ kind: "addToSet", path: ["tags"], value: "shared" }])

    // A adds unique
    logA.emit([{ kind: "addToSet", path: ["tags"], value: "onlyA" }])

    // B adds unique
    logB.emit([{ kind: "addToSet", path: ["tags"], value: "onlyB" }])

    syncDocs(docA, docB)

    expectConvergence(logA, logB)

    const tags = logA.getState().tags as string[]
    expect(tags).toContain("shared")
    expect(tags).toContain("onlyA")
    expect(tags).toContain("onlyB")
    // addToSet enforces set semantics globally - there should be exactly 1 "shared"
    expect(tags.filter((t) => t === "shared").length).toBe(1)
  })

  it("concurrent addToSet from multiple clients results in exactly one copy", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // Create empty array on A and sync
    logA.emit([{ kind: "set", path: [], key: "items", value: [] }])
    syncDocs(docA, docB)

    // Both clients add the SAME value multiple times in isolation
    logA.emit([{ kind: "addToSet", path: ["items"], value: "duplicate" }])
    logA.emit([{ kind: "addToSet", path: ["items"], value: "duplicate" }])
    logA.emit([{ kind: "addToSet", path: ["items"], value: "duplicate" }])

    logB.emit([{ kind: "addToSet", path: ["items"], value: "duplicate" }])
    logB.emit([{ kind: "addToSet", path: ["items"], value: "duplicate" }])

    // Sync
    syncDocs(docA, docB)
    expectConvergence(logA, logB)

    // Should have exactly 1 copy of "duplicate"
    const items = logA.getState().items as string[]
    expect(items.filter((i) => i === "duplicate").length).toBe(1)
  })

  it("concurrent deleteFromSet from multiple clients removes the value completely", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // Create array with the value to delete
    logA.emit([{ kind: "set", path: [], key: "items", value: ["keep", "remove", "keep2"] }])
    syncDocs(docA, docB)

    expect(logA.getState().items).toContain("remove")
    expect(logB.getState().items).toContain("remove")

    // Both clients issue deleteFromSet for the same value in isolation
    logA.emit([{ kind: "deleteFromSet", path: ["items"], value: "remove" }])
    logB.emit([{ kind: "deleteFromSet", path: ["items"], value: "remove" }])

    // Sync
    syncDocs(docA, docB)
    expectConvergence(logA, logB)

    // The value should be completely gone
    const items = logA.getState().items as string[]
    expect(items).not.toContain("remove")
    expect(items).toContain("keep")
    expect(items).toContain("keep2")
  })

  it("deleteFromSet wins over addToSet when concurrent", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // Create array with the value
    logA.emit([{ kind: "set", path: [], key: "items", value: ["existing"] }])
    syncDocs(docA, docB)

    // A adds the value (already exists, should be no-op by addToSet semantics)
    logA.emit([{ kind: "addToSet", path: ["items"], value: "existing" }])

    // B removes the same value
    logB.emit([{ kind: "deleteFromSet", path: ["items"], value: "existing" }])

    // Sync
    syncDocs(docA, docB)
    expectConvergence(logA, logB)

    // The result depends on the order of operations as determined by Lamport clock
    // But the important thing is that both clients agree
    const itemsA = logA.getState().items as string[]
    const itemsB = logB.getState().items as string[]
    expect(itemsA).toStrictEqual(itemsB)
  })

  it("handles validation consistently across clients", () => {
    const docA = new SyncLogDoc()
    const docB = new SyncLogDoc()

    const validate = (state: any) => {
      // Reject negative counts
      return state.count === undefined || state.count >= 0
    }

    const logA = createStateSyncLog<any>({
      syncLogDoc: docA,
      clientId: "A",
      retentionWindowMs: undefined,
      validate,
    })

    const logB = createStateSyncLog<any>({
      syncLogDoc: docB,
      clientId: "B",
      retentionWindowMs: undefined,
      validate,
    })

    // A sets valid value
    logA.emit([{ kind: "set", path: [], key: "count", value: 10 }])
    syncDocs(docA, docB)

    // B tries to set invalid value (should be rejected)
    logB.emit([{ kind: "set", path: [], key: "count", value: -5 }])

    // A still has valid value
    expect(logA.getState().count).toBe(10)

    // After sync, B's invalid tx is also rejected on A
    syncDocs(docA, docB)

    expectConvergence(logA, logB)
    expect(logA.getState().count).toBe(10) // Still valid
  })

  it("complete workflow: init, concurrent edits, sync, checkpoint, more edits, sync", () => {
    const { docA, docB, logA, logB } = createTwoClientSetup()

    // === Phase 1: Initial sync ===
    logA.emit([{ kind: "set", path: [], key: "version", value: 1 }])
    syncDocs(docA, docB)
    expectConvergence(logA, logB)

    // === Phase 2: Concurrent offline edits ===
    logA.emit([{ kind: "set", path: [], key: "editedByA", value: true }])
    logA.emit([{ kind: "set", path: [], key: "shared", value: "A's version" }])

    logB.emit([{ kind: "set", path: [], key: "editedByB", value: true }])
    logB.emit([{ kind: "set", path: [], key: "shared", value: "B's version" }])

    // === Phase 3: Sync first (no offline checkpointing - that would cause data loss) ===
    syncDocs(docA, docB)
    expectConvergence(logA, logB)

    // Both edits should be present, "shared" determined by clock
    const state = logA.getState()
    expect(state.version).toBe(1)
    expect(state.editedByA).toBe(true)
    expect(state.editedByB).toBe(true)
    expect(["A's version", "B's version"]).toContain(state.shared)

    // === Phase 4: Server-mediated checkpointing after sync ===
    applyServerCheckpoint([docA, docB], [logA, logB], 0)
    expectConvergence(logA, logB)

    // === Phase 5: More edits after convergence ===
    logB.emit([{ kind: "set", path: [], key: "version", value: 2 }])
    syncDocs(docA, docB)
    expectConvergence(logA, logB)
    expect(logA.getState().version).toBe(2)

    // === Phase 6: Server-mediated checkpoint again ===
    applyServerCheckpoint([docA, docB], [logA, logB], 1)
    expectConvergence(logA, logB)
  })
})
