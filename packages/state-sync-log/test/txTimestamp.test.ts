import { describe, expect, it } from "vitest"
import { compareTxTimestamps, parseTxTimestampKey, txTimestampToKey } from "../src/txTimestamp"

describe("TxTimestamp", () => {
  it("throws on malformed timestamp key", () => {
    expect(() => parseTxTimestampKey("invalid")).toThrow(/Malformed timestamp key/)
  })

  it("compares identical timestamps correctly", () => {
    const ts = { epoch: 1, clock: 1, clientId: "A", wallClock: 100 }
    expect(compareTxTimestamps(ts, ts)).toBe(0)
  })

  it("txTimestampToKey formats correctly", () => {
    const ts = { epoch: 10, clock: 5, clientId: "alice", wallClock: 123456789 }
    expect(txTimestampToKey(ts)).toBe("alice;5;;10;123456789")
  })

  it("compareTxTimestamps orders by epoch", () => {
    const a = { epoch: 1, clock: 10, clientId: "a", wallClock: 100 }
    const b = { epoch: 2, clock: 5, clientId: "a", wallClock: 100 }
    expect(compareTxTimestamps(a, b)).toBeLessThan(0)
    expect(compareTxTimestamps(b, a)).toBeGreaterThan(0)
  })

  it("compareTxTimestamps orders by clock when epochs equal", () => {
    const a = { epoch: 1, clock: 5, clientId: "a", wallClock: 100 }
    const b = { epoch: 1, clock: 10, clientId: "a", wallClock: 100 }
    expect(compareTxTimestamps(a, b)).toBeLessThan(0)
    expect(compareTxTimestamps(b, a)).toBeGreaterThan(0)
  })

  it("compareTxTimestamps orders by clientId when epoch/clock equal", () => {
    const a = { epoch: 1, clock: 10, clientId: "a", wallClock: 100 }
    const b = { epoch: 1, clock: 10, clientId: "b", wallClock: 100 }
    expect(compareTxTimestamps(a, b)).toBeLessThan(0)
    expect(compareTxTimestamps(b, a)).toBeGreaterThan(0)
  })
})
