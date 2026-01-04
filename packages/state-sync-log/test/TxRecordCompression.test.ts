import { describe, expect, it } from "vitest"
import { Op } from "../src/operations"
import { TxRecord } from "../src/TxRecord"
import { decodeTxRecord, encodeTxRecord } from "../src/TxRecordCompression"

describe("TxRecordCompression", () => {
  it("roundtrips all op types correctly", () => {
    const allOps: Op[] = [
      { kind: "set", path: ["a"], key: "b", value: { nested: [1, 2, 3] } },
      { kind: "delete", path: ["x"], key: 5 },
      { kind: "splice", path: [], index: 0, deleteCount: 2, inserts: ["a", "b"] },
      { kind: "addToSet", path: ["tags"], value: "item" },
      { kind: "deleteFromSet", path: ["set"], value: null },
    ]

    const record: TxRecord = { ops: allOps }
    const decoded = decodeTxRecord(encodeTxRecord(record))
    expect(decoded).toEqual(record)
  })

  it("preserves originalTxKey when present", () => {
    const record: TxRecord = {
      ops: [{ kind: "set", path: [], key: "a", value: 1 }],
      originalTxKey: "client1;1;;5;1234567890",
    }

    const decoded = decodeTxRecord(encodeTxRecord(record))
    expect(decoded).toEqual(record)
  })

  it("uses correct numeric discriminators", () => {
    const record: TxRecord = {
      ops: [
        { kind: "set", path: [], key: "k", value: 1 },
        { kind: "delete", path: [], key: "k" },
        { kind: "splice", path: [], index: 0, deleteCount: 0, inserts: [] },
        { kind: "addToSet", path: [], value: "v" },
        { kind: "deleteFromSet", path: [], value: "v" },
      ],
    }

    const [ops] = encodeTxRecord(record) as [number[][]]
    expect(ops.map((op) => op[0])).toEqual([0, 1, 2, 3, 4])
  })

  it("produces smaller output than original JSON", () => {
    const record: TxRecord = {
      ops: [
        { kind: "set", path: ["users", "123"], key: "name", value: "John" },
        { kind: "delete", path: ["users"], key: "old" },
      ],
    }

    const originalJson = JSON.stringify(record)
    const encodedJson = JSON.stringify(encodeTxRecord(record))
    expect(encodedJson.length).toBeLessThan(originalJson.length)
  })
})
