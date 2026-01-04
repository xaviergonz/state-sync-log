import { describe, expect, it } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog, getSortedTxsSymbol } from "../src/createStateSyncLog"
import { applyLocalCheckpoint } from "./utils"

describe("Deduplication Edge Cases", () => {
  describe("Checkpoint-based pruning", () => {
    it("txs are pruned after checkpoint", () => {
      const docA = new SyncLogDoc()
      const logA = createStateSyncLog<any>({
        syncLogDoc: docA,
        clientId: "A",
        retentionWindowMs: undefined,
      })

      // A creates a tx
      logA.emit([{ kind: "set", path: [], key: "counter", value: 1 }])

      // A creates checkpoint - this creates a checkpoint including the tx
      applyLocalCheckpoint(logA)

      // The tx should be pruned after checkpoint
      const txs = logA[getSortedTxsSymbol]()
      expect(txs.length).toBe(0)

      // The state should still have the value from the checkpoint
      expect(logA.getState().counter).toBe(1)
    })

    it("txs in a received checkpoint are not duplicated", () => {
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

      // A creates T1 and creates checkpoint
      logA.emit([{ kind: "set", path: [], key: "val", value: 1 }])
      applyLocalCheckpoint(logA)

      // Sync A to B (B receives checkpoint)
      docB.applyUpdate(docA.encodeStateAsUpdate())

      // B should have the correct state
      expect(logB.getState().val).toBe(1)

      // B should not have any pending txs
      expect(logB[getSortedTxsSymbol]().length).toBe(0)
    })
  })

  describe("Re-emit deduplication", () => {
    it("re-emitted txs are not applied twice", () => {
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

      // Both start with same base
      logA.emit([{ kind: "set", path: [], key: "arr", value: [] }])
      docB.applyUpdate(docA.encodeStateAsUpdate())

      // A emits a splice (adds element to array)
      logA.emit([{ kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [1] }])

      // B creates checkpoint (misses T1)
      applyLocalCheckpoint(logB)

      // Sync A to B - B receives T1, re-emits it
      docB.applyUpdate(docA.encodeStateAsUpdate())
      expect(logB.getState().arr).toStrictEqual([1])

      // Sync B back to A - A receives the re-emit
      docA.applyUpdate(docB.encodeStateAsUpdate())

      // A should still have [1], NOT [1, 1]
      expect(logA.getState().arr).toStrictEqual([1])
    })

    it("original and re-emit arriving at third client are deduplicated", () => {
      const docA = new SyncLogDoc()
      const docB = new SyncLogDoc()
      const docC = new SyncLogDoc()

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
      const logC = createStateSyncLog<any>({
        syncLogDoc: docC,
        clientId: "C",
        retentionWindowMs: undefined,
      })

      // All start with same base
      logA.emit([{ kind: "set", path: [], key: "arr", value: [] }])
      docB.applyUpdate(docA.encodeStateAsUpdate())
      docC.applyUpdate(docA.encodeStateAsUpdate())

      // A emits T1 (push 1)
      logA.emit([{ kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [1] }])

      // B creates checkpoint (doesn't have T1)
      applyLocalCheckpoint(logB)

      // B receives T1 from A, re-emits as T1'
      docB.applyUpdate(docA.encodeStateAsUpdate())

      // C receives BOTH T1 from A and T1' from B
      docC.applyUpdate(docA.encodeStateAsUpdate())
      docC.applyUpdate(docB.encodeStateAsUpdate())

      // C should have [1], NOT [1, 1]
      expect(logC.getState().arr).toStrictEqual([1])
    })
  })
})
