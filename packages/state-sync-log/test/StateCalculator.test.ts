import { beforeEach, describe, expect, it } from "vitest"
import { CheckpointRecord } from "../src/checkpoints"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { SyncLogMap } from "../src/crdt/SyncLogMap"
import { JSONValue } from "../src/json"
import { Op } from "../src/operations"
import { StateCalculator } from "../src/StateCalculator"
import { EncodedTxRecord, encodeTxRecord } from "../src/TxRecordCompression"
import { TxTimestamp, txTimestampToKey } from "../src/txTimestamp"

function createTxKey(epoch: number, clock: number, clientId: string): string {
  const ts: TxTimestamp = { epoch, clock, clientId, wallClock: Date.now() }
  return txTimestampToKey(ts)
}

function setOp(key: string, value: JSONValue): Op {
  return { kind: "set", path: [], key, value }
}

describe("StateCalculator", () => {
  let doc: SyncLogDoc
  let txMap: SyncLogMap<EncodedTxRecord>
  let calc: StateCalculator

  beforeEach(() => {
    doc = new SyncLogDoc()
    txMap = doc.getMap<EncodedTxRecord>("tx")
    calc = new StateCalculator()
  })

  describe("Transaction Management (Insert/Remove)", () => {
    it("maintains sorted order of transactions", () => {
      const k1 = createTxKey(1, 1, "c1")
      const k2 = createTxKey(1, 2, "c1")
      const k3 = createTxKey(1, 3, "c1")

      txMap.set(k2, encodeTxRecord({ ops: [setOp("b", 2)] }))
      txMap.set(k3, encodeTxRecord({ ops: [setOp("c", 3)] }))
      txMap.set(k1, encodeTxRecord({ ops: [setOp("a", 1)] }))

      // Insert out of order
      calc.insertTx(k2, txMap)
      calc.insertTx(k1, txMap)
      calc.insertTx(k3, txMap)

      const sorted = calc.getSortedTxs()
      expect(sorted.map((s) => s.txTimestampKey)).toEqual([k1, k2, k3])
      expect(calc.txCount).toBe(3)
    })

    it("handles duplicates and maxSeenClock", () => {
      const k1 = createTxKey(1, 5, "c1")
      txMap.set(k1, encodeTxRecord({ ops: [setOp("a", 1)] }))

      expect(calc.insertTx(k1, txMap)).toBe(false)
      expect(calc.insertTx(k1, txMap)).toBe(false) // Duplicate
      expect(calc.getMaxSeenClock()).toBe(5)
    })

    it("manages removal correctly", () => {
      const k1 = createTxKey(1, 1, "c1")
      const k2 = createTxKey(1, 2, "c1")
      txMap.set(k1, encodeTxRecord({ ops: [setOp("a", 1)] }))
      txMap.set(k2, encodeTxRecord({ ops: [setOp("b", 2)] }))

      calc.insertTx(k1, txMap)
      calc.insertTx(k2, txMap)

      expect(calc.removeTxs([k1, "nonexistent"])).toBe(1)
      expect(calc.txCount).toBe(1)
      expect(calc.hasTx(k1)).toBe(false)
      expect(calc.hasTx(k2)).toBe(true)
    })
  })

  describe("Cache Invalidation", () => {
    const k1 = createTxKey(1, 1, "c1")
    const k2 = createTxKey(1, 2, "c1")
    const k3 = createTxKey(1, 3, "c1")

    beforeEach(() => {
      txMap.set(k1, encodeTxRecord({ ops: [setOp("a", 1)] }))
      txMap.set(k2, encodeTxRecord({ ops: [setOp("b", 2)] }))
      txMap.set(k3, encodeTxRecord({ ops: [setOp("c", 3)] }))
    })

    it("invalidates on out-of-order insert (before calculated slice)", () => {
      calc.insertTx(k2, txMap)
      calc.insertTx(k3, txMap)
      calc.calculateState() // Sets lastAppliedIndex
      expect(calc.needsFullRecalculation()).toBe(false)

      expect(calc.insertTx(k1, txMap)).toBe(true) // Insert before k2
      expect(calc.needsFullRecalculation()).toBe(true)
    })

    it("does NOT invalidate on append (after calculated slice)", () => {
      calc.insertTx(k1, txMap)
      calc.calculateState()
      expect(calc.needsFullRecalculation()).toBe(false)

      expect(calc.insertTx(k2, txMap)).toBe(false) // Insert after k1
      expect(calc.needsFullRecalculation()).toBe(false)
    })

    it("invalidates on removing from calculated slice", () => {
      calc.insertTx(k1, txMap)
      calc.insertTx(k2, txMap)
      calc.calculateState()

      calc.removeTxs([k1])
      expect(calc.needsFullRecalculation()).toBe(true)
    })

    it("rebuilds from SyncLogMap clearing cache", () => {
      calc.insertTx(k1, txMap)
      calc.calculateState()

      // Simulate external change + rebuild
      txMap.delete(k1)
      calc.rebuildFromSyncLogMap(txMap)

      expect(calc.txCount).toBe(2)
      expect(calc.needsFullRecalculation()).toBe(true)
    })
  })

  describe("State Calculation", () => {
    it("calculates state cumulatively", () => {
      const k1 = createTxKey(1, 1, "c1")
      const k2 = createTxKey(1, 2, "c1")
      txMap.set(k1, encodeTxRecord({ ops: [setOp("a", 1)] }))
      txMap.set(k2, encodeTxRecord({ ops: [setOp("b", 2)] }))

      calc.insertTx(k1, txMap)
      calc.insertTx(k2, txMap)

      const { state, getAppliedOps } = calc.calculateState()
      expect(state).toEqual({ a: 1, b: 2 })
      expect(getAppliedOps().length).toBe(2)
    })

    it("supports incremental updates", () => {
      const k1 = createTxKey(1, 1, "c1")
      const k2 = createTxKey(1, 2, "c1")
      txMap.set(k1, encodeTxRecord({ ops: [setOp("a", 1)] }))
      calc.insertTx(k1, txMap)

      // Step 1
      let res = calc.calculateState()
      expect(res.state).toEqual({ a: 1 })

      // Step 2: Add k2
      txMap.set(k2, encodeTxRecord({ ops: [setOp("b", 2)] }))
      calc.insertTx(k2, txMap)

      expect(calc.needsFullRecalculation()).toBe(false)
      res = calc.calculateState()
      expect(res.state).toEqual({ a: 1, b: 2 })
      expect(res.getAppliedOps()).toEqual([setOp("b", 2)]) // Only new ops
    })

    it("deduplicates re-emitted transactions", () => {
      const k1 = createTxKey(1, 1, "c1")
      const k1_re = createTxKey(2, 2, "c1") // Same logical tx, diff key

      txMap.set(k1, encodeTxRecord({ ops: [setOp("a", 1)] }))
      txMap.set(k1_re, encodeTxRecord({ ops: [setOp("a", 1)], originalTxKey: k1 }))

      calc.insertTx(k1, txMap)
      calc.insertTx(k1_re, txMap)

      const { state } = calc.calculateState()
      expect(state).toEqual({ a: 1 }) // Applied only once
    })

    it("respects validation function", () => {
      const validate = (s: any) => !s.blocked
      calc = new StateCalculator(validate)
      const k1 = createTxKey(1, 1, "c1")

      txMap.set(k1, encodeTxRecord({ ops: [setOp("blocked", true)] }))
      calc.insertTx(k1, txMap)

      const { state } = calc.calculateState()
      expect(state).toEqual({}) // Rejected
    })
  })

  describe("Checkpoints", () => {
    it("uses checkpoint as base state", () => {
      const cp: CheckpointRecord = {
        txCount: 10,
        state: { base: true },
        watermarks: {},
        minWallClock: Date.now(),
      }
      calc.setBaseCheckpoint(cp)

      const k1 = createTxKey(1, 1, "c1")
      txMap.set(k1, encodeTxRecord({ ops: [setOp("new", true)] }))
      calc.insertTx(k1, txMap)

      const { state } = calc.calculateState()
      expect(state).toEqual({ base: true, new: true })
    })

    it("skips transactions covered by checkpoint watermarks", () => {
      const cp: CheckpointRecord = {
        txCount: 5,
        state: { a: 1 },
        watermarks: { c1: { maxClock: 10, maxWallClock: 0 } },
        minWallClock: 0,
      }
      calc.setBaseCheckpoint(cp)

      // k1 is covered (clock 5 <= 10)
      const k1 = createTxKey(1, 5, "c1")
      // k2 is NEW (clock 11 > 10)
      const k2 = createTxKey(1, 11, "c1")

      txMap.set(k1, encodeTxRecord({ ops: [setOp("b", 2)] }))
      txMap.set(k2, encodeTxRecord({ ops: [setOp("c", 3)] }))

      calc.insertTx(k1, txMap)
      calc.insertTx(k2, txMap)

      const { state } = calc.calculateState()
      expect(state).toEqual({ a: 1, c: 3 }) // b:2 skipped
    })

    it("invalidates state when checkpoint changes", () => {
      const k1 = createTxKey(1, 1, "c1")
      txMap.set(k1, encodeTxRecord({ ops: [setOp("a", 1)] }))
      calc.insertTx(k1, txMap)
      calc.calculateState()

      const cp: CheckpointRecord = {
        txCount: 0,
        state: {},
        watermarks: {},
        minWallClock: 0,
      }

      expect(calc.needsFullRecalculation()).toBe(false)
      calc.setBaseCheckpoint(cp)
      expect(calc.needsFullRecalculation()).toBe(true)
    })
  })
})
