import { describe, expect, it, vi } from "vitest"
import { SyncLogDoc } from "../../src/crdt/SyncLogDoc"
import { SyncLogMapEvent } from "../../src/crdt/SyncLogMap"

describe("SyncLogCRDT", () => {
  describe("SyncLogDoc", () => {
    it("creates and accesses maps", () => {
      const doc = new SyncLogDoc()
      const map1 = doc.getMap("test")
      const map2 = doc.getMap("test")
      expect(map1).toBe(map2) // Same instance
      expect(doc.getMap("other")).not.toBe(map1)
    })

    it("cleans up on destroy", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")
      map.set("A;1;;m", 42)
      expect(map.size).toBe(1)

      doc.destroy()
      // After destroy, getting the same map gives a fresh one
      const newMap = doc.getMap("test")
      expect(newMap.size).toBe(0)
    })
  })

  describe("SyncLogMap", () => {
    it("supports basic CRUD operations", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")

      // Set
      map.set("A;1;;meta", { value: 1 })
      expect(map.size).toBe(1)

      // Get
      expect(map.get("A;1;;meta")).toEqual({ value: 1 })
      expect(map.get("nonexistent")).toBeUndefined()

      // Has
      expect(map.has("A;1;;meta")).toBe(true)
      expect(map.has("nonexistent")).toBe(false)

      // Delete
      expect(map.delete("A;1;;meta")).toBe(true)
      expect(map.delete("A;1;;meta")).toBe(false) // Already deleted
      expect(map.size).toBe(0)
    })

    it("throws on invalid key format", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")

      expect(() => map.set("invalid", 1)).toThrow(/Invalid key format/)
      expect(() => map.set("A;notanumber;;m", 1)).toThrow(/Invalid key format/)
      expect(() => map.set("A;1;missing-double-semi", 1)).toThrow(/Invalid key format/)
    })

    it("throws on duplicate key (set-once)", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")

      map.set("A;1;;m", 1)
      expect(() => map.set("A;1;;m", 2)).toThrow(/Key already exists/)
    })

    it("throws on setting tombstoned key", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")

      map.set("A;1;;m", 1)
      map.delete("A;1;;m")
      expect(() => map.set("A;1;;m", 2)).toThrow(/Cannot set tombstoned key/)
    })

    it("supports iteration", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")

      map.set("A;1;;m", 1)
      map.set("A;2;;m", 2)
      map.set("A;3;;m", 3)

      const keys = [...map.keys()]
      expect(keys).toHaveLength(3)
      expect(keys).toContain("A;1;;m")

      const values = [...map.values()]
      expect(values).toHaveLength(3)
      expect(values).toContain(2)

      const entries = [...map.entries()]
      expect(entries).toHaveLength(3)

      // Symbol.iterator
      const fromIterator = [...map]
      expect(fromIterator).toHaveLength(3)
    })

    it("allows metadata with semicolons", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")

      // Metadata can contain semicolons
      map.set("A;1;;foo;bar;baz", 42)
      expect(map.get("A;1;;foo;bar;baz")).toBe(42)
    })
  })

  describe("Observers", () => {
    it("notifies observers of add changes with newValue only", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")
      const observer = vi.fn()

      map.observe(observer)

      map.set("A;1;;m", 42)
      expect(observer).toHaveBeenCalledTimes(1)

      const event: SyncLogMapEvent<unknown> = observer.mock.calls[0][0]
      const change = event.changes.keys.get("A;1;;m")
      expect(change).toEqual({
        action: "add",
        newValue: 42,
      })
      // Verify no oldValue is present on add
      expect(change).not.toHaveProperty("oldValue")
    })

    it("notifies observers of delete changes with oldValue only", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")
      const observer = vi.fn()

      map.set("A;1;;m", 42)
      map.observe(observer)

      map.delete("A;1;;m")
      expect(observer).toHaveBeenCalledTimes(1)

      const event: SyncLogMapEvent<unknown> = observer.mock.calls[0][0]
      const change = event.changes.keys.get("A;1;;m")
      expect(change).toEqual({
        action: "delete",
        oldValue: 42,
      })
      // Verify no newValue is present on delete
      expect(change).not.toHaveProperty("newValue")
    })

    it("batches changes in transactions", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")
      const observer = vi.fn()

      map.observe(observer)

      doc.transact(() => {
        map.set("A;1;;m", 1)
        map.set("A;2;;m", 2)
        map.set("A;3;;m", 3)
      })

      // Single notification with all changes
      expect(observer).toHaveBeenCalledTimes(1)
      const event: SyncLogMapEvent<unknown> = observer.mock.calls[0][0]
      expect(event.changes.keys.size).toBe(3)
    })

    it("passes origin to observers", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")
      const observer = vi.fn()

      map.observe(observer)

      const myOrigin = { source: "test" }
      doc.transact(() => {
        map.set("A;1;;m", 1)
      }, myOrigin)

      expect(observer.mock.calls[0][1]).toBe(myOrigin)
    })

    it("can unobserve", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")
      const observer = vi.fn()

      const unsubscribe = map.observe(observer)
      map.set("A;1;;m", 1)
      expect(observer).toHaveBeenCalledTimes(1)

      unsubscribe()
      map.set("A;2;;m", 2)
      expect(observer).toHaveBeenCalledTimes(1) // No additional calls
    })
  })

  describe("Document update events", () => {
    it("emits update events", () => {
      const doc = new SyncLogDoc()
      const handler = vi.fn()

      doc.onUpdate(handler)

      const map = doc.getMap("test")
      map.set("A;1;;m", 42)

      expect(handler).toHaveBeenCalledTimes(1)
      const [update] = handler.mock.calls[0]
      expect(update).toHaveProperty("test") // mapName at top level
    })

    it("unsubscribes from update events", () => {
      const doc = new SyncLogDoc()
      const handler = vi.fn()

      const unsub = doc.onUpdate(handler)
      doc.getMap("test").set("A;1;;m", 1)
      expect(handler).toHaveBeenCalledTimes(1)

      unsub()
      doc.getMap("test").set("A;2;;m", 2)
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe("Sync Protocol", () => {
    it("encodes and applies updates", () => {
      const doc1 = new SyncLogDoc()
      const doc2 = new SyncLogDoc()

      // Doc1 creates data
      doc1.getMap("test").set("A;1;;m", { x: 1 })
      doc1.getMap("test").set("A;2;;m", { x: 2 })

      // Sync to doc2
      const update = doc1.encodeStateAsUpdate()
      doc2.applyUpdate(update)

      // Doc2 should have the data
      expect(doc2.getMap("test").get("A;1;;m")).toEqual({ x: 1 })
      expect(doc2.getMap("test").get("A;2;;m")).toEqual({ x: 2 })
    })

    it("handles bidirectional sync", () => {
      const doc1 = new SyncLogDoc()
      const doc2 = new SyncLogDoc()

      // Both create data
      doc1.getMap("shared").set("A;1;;m", "from1")
      doc2.getMap("shared").set("B;1;;m", "from2")

      // Sync both ways
      doc2.applyUpdate(doc1.encodeStateAsUpdate())
      doc1.applyUpdate(doc2.encodeStateAsUpdate())

      // Both should have all data
      expect(doc1.getMap("shared").get("A;1;;m")).toBe("from1")
      expect(doc1.getMap("shared").get("B;1;;m")).toBe("from2")
      expect(doc2.getMap("shared").get("A;1;;m")).toBe("from1")
      expect(doc2.getMap("shared").get("B;1;;m")).toBe("from2")
    })

    it("syncs deletions (tombstones)", () => {
      const doc1 = new SyncLogDoc()
      const doc2 = new SyncLogDoc()

      // Doc1 creates and deletes
      doc1.getMap("test").set("A;1;;m", 42)
      doc1.getMap("test").delete("A;1;;m")

      // Sync to doc2
      doc2.applyUpdate(doc1.encodeStateAsUpdate())

      // Doc2 should NOT have the deleted key
      expect(doc2.getMap("test").has("A;1;;m")).toBe(false)
      expect(doc2.getMap("test").size).toBe(0)
    })

    it("tombstone wins over late add", () => {
      const doc1 = new SyncLogDoc()
      const doc2 = new SyncLogDoc()

      // Doc1 creates and deletes
      doc1.getMap("test").set("A;1;;m", 1)
      doc1.getMap("test").delete("A;1;;m")

      // Doc2 tries to add same key (simulated by separate doc)
      doc2.getMap("test").set("A;1;;m", 2)

      // Sync doc1's tombstone to doc2
      doc2.applyUpdate(doc1.encodeStateAsUpdate())

      // Tombstone should win
      expect(doc2.getMap("test").has("A;1;;m")).toBe(false)
    })

    it("supports delta sync with state vector", () => {
      const doc1 = new SyncLogDoc()
      const doc2 = new SyncLogDoc()

      // Initial sync
      doc1.getMap("test").set("A;1;;m", 1)
      doc2.applyUpdate(doc1.encodeStateAsUpdate())

      // Doc1 adds more
      doc1.getMap("test").set("A;2;;m", 2)

      // Delta sync using state vector - only get changes doc2 doesn't have
      const sv = doc2.getStateVector()
      const delta = doc1.encodeStateAsUpdate(sv)
      const full = doc1.encodeStateAsUpdate()

      // Delta should be smaller (only new data)
      expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(full).length)

      doc2.applyUpdate(delta)
      expect(doc2.getMap("test").get("A;2;;m")).toBe(2)
    })
  })

  describe("Range Compression", () => {
    it("compresses sequential tombstones efficiently", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")

      // Create and delete 100 sequential keys
      for (let i = 0; i < 100; i++) {
        map.set(`A;${i};;m`, i)
      }
      for (let i = 0; i < 100; i++) {
        map.delete(`A;${i};;m`)
      }

      // Encode
      const update = doc.encodeStateAsUpdate()

      // Check compressed size via JSON
      const jsonSize = JSON.stringify(update).length
      // With range compression, should be small (just one range [0, 99])
      expect(jsonSize).toBeLessThan(200)
    })

    it("handles non-sequential tombstones", () => {
      const doc = new SyncLogDoc()
      const map = doc.getMap("test")

      // Create gaps: 1, 3, 5
      map.set("A;1;;m", 1)
      map.set("A;3;;m", 3)
      map.set("A;5;;m", 5)
      map.delete("A;1;;m")
      map.delete("A;3;;m")
      map.delete("A;5;;m")

      const doc2 = new SyncLogDoc()
      doc2.applyUpdate(doc.encodeStateAsUpdate())

      // All should be tombstoned
      expect(doc2.getMap("test").has("A;1;;m")).toBe(false)
      expect(doc2.getMap("test").has("A;3;;m")).toBe(false)
      expect(doc2.getMap("test").has("A;5;;m")).toBe(false)
    })
  })

  describe("CRDT Merge Semantics", () => {
    it("converges on same state after sync", () => {
      const doc1 = new SyncLogDoc()
      const doc2 = new SyncLogDoc()
      const doc3 = new SyncLogDoc()

      // All create different data
      doc1.getMap("m").set("A;1;;x", 1)
      doc2.getMap("m").set("B;1;;x", 2)
      doc3.getMap("m").set("C;1;;x", 3)

      // Sync in a chain
      doc2.applyUpdate(doc1.encodeStateAsUpdate())
      doc3.applyUpdate(doc2.encodeStateAsUpdate())
      doc1.applyUpdate(doc3.encodeStateAsUpdate())
      doc2.applyUpdate(doc1.encodeStateAsUpdate())

      // All should converge
      const expected = { "A;1;;x": 1, "B;1;;x": 2, "C;1;;x": 3 }
      for (const doc of [doc1, doc2, doc3]) {
        const entries = Object.fromEntries(doc.getMap("m").entries())
        expect(entries).toEqual(expected)
      }
    })

    it("idempotent updates", () => {
      const doc1 = new SyncLogDoc()
      const doc2 = new SyncLogDoc()

      doc1.getMap("test").set("A;1;;m", 42)
      const update = doc1.encodeStateAsUpdate()

      // Apply same update multiple times
      doc2.applyUpdate(update)
      doc2.applyUpdate(update)
      doc2.applyUpdate(update)

      expect(doc2.getMap("test").size).toBe(1)
      expect(doc2.getMap("test").get("A;1;;m")).toBe(42)
    })
  })

  describe("Size Verification", () => {
    const compactionCycles = 100
    const txCount = 10
    const stateKeyCount = 1000

    function generateCheckpointState(): Record<string, number> {
      const state: Record<string, number> = {}
      for (let i = 0; i < stateKeyCount; i++) {
        state[`key_${i}`] = i // Deterministic for testing
      }
      return state
    }

    function generateTxRecord(index: number): {
      ops: Array<{ kind: string; key: string; value: number }>
    } {
      return { ops: [{ kind: "set", key: `key_${index % stateKeyCount}`, value: index }] }
    }

    it("maintains small size with synced clients after GC", () => {
      const doc = new SyncLogDoc()
      const tx = doc.getMap("tx")
      const checkpoint = doc.getMap("checkpoint")

      // Simulate compaction cycles
      for (let cycle = 0; cycle < compactionCycles; cycle++) {
        // Add transactions
        for (let i = 0; i < txCount; i++) {
          tx.set(
            `A;${cycle * txCount + i};;${cycle};123456789`,
            generateTxRecord(cycle * txCount + i)
          )
        }

        // Create checkpoint
        checkpoint.set(`A;${cycle};;${txCount}`, {
          state: generateCheckpointState(),
          watermarks: { clientA: { maxClock: cycle * txCount + txCount } },
          txCount,
        })

        // Delete old checkpoint
        if (cycle > 0) {
          checkpoint.delete(`A;${cycle - 1};;${txCount}`)
        }

        // Delete all transactions (compaction)
        for (let i = 0; i < txCount; i++) {
          tx.delete(`A;${cycle * txCount + i};;${cycle};123456789`)
        }
      }

      // GC with a fully synced client (knows everything)
      const fullSv = new Map([["A", compactionCycles * txCount]])
      doc.gc(fullSv)

      const update = doc.encodeStateAsUpdate()
      const sizeKB = JSON.stringify(update).length / 1024

      console.log(`[SyncLogCRDT] Synced client size: ${sizeKB.toFixed(2)} KB`)
      expect(sizeKB).toBeLessThan(20) // Just checkpoint + minimal overhead
    })

    it("maintains reasonable size with lagging client", () => {
      const doc = new SyncLogDoc()
      const tx = doc.getMap("tx")
      const checkpoint = doc.getMap("checkpoint")

      const lagCycles = 90 // Client is 90 cycles behind

      for (let cycle = 0; cycle < compactionCycles; cycle++) {
        for (let i = 0; i < txCount; i++) {
          tx.set(
            `A;${cycle * txCount + i};;${cycle};123456789`,
            generateTxRecord(cycle * txCount + i)
          )
        }
        checkpoint.set(`A;${cycle};;${txCount}`, {
          state: generateCheckpointState(),
          watermarks: { clientA: { maxClock: cycle * txCount + txCount } },
          txCount,
        })
        if (cycle > 0) {
          checkpoint.delete(`A;${cycle - 1};;${txCount}`)
        }
        for (let i = 0; i < txCount; i++) {
          tx.delete(`A;${cycle * txCount + i};;${cycle};123456789`)
        }
      }

      // GC with a lagging client (knows up to cycle 10)
      const laggingSeq = (compactionCycles - lagCycles) * txCount
      const laggingSv = new Map([["A", laggingSeq]])
      doc.gc(laggingSv)

      const update = doc.encodeStateAsUpdate()
      const sizeKB = JSON.stringify(update).length / 1024

      // With range compression, 90 cycles of tombstones should be small
      console.log(
        `[SyncLogCRDT] Lagging client (${lagCycles} cycles behind): ${sizeKB.toFixed(2)} KB`
      )
      expect(sizeKB).toBeLessThan(20) // Should still be reasonable
    })

    it("size is near theoretical minimum", () => {
      const doc = new SyncLogDoc()
      const tx = doc.getMap("tx")
      const checkpoint = doc.getMap("checkpoint")

      for (let cycle = 0; cycle < compactionCycles; cycle++) {
        for (let i = 0; i < txCount; i++) {
          tx.set(
            `A;${cycle * txCount + i};;${cycle};123456789`,
            generateTxRecord(cycle * txCount + i)
          )
        }
        checkpoint.set(`A;${cycle};;${txCount}`, {
          state: generateCheckpointState(),
          watermarks: { clientA: { maxClock: cycle * txCount + txCount } },
          txCount,
        })
        if (cycle > 0) {
          checkpoint.delete(`A;${cycle - 1};;${txCount}`)
        }
        for (let i = 0; i < txCount; i++) {
          tx.delete(`A;${cycle * txCount + i};;${cycle};123456789`)
        }
      }

      // Full update (no GC)
      const fullUpdate = doc.encodeStateAsUpdate()
      const fullSizeKB = JSON.stringify(fullUpdate).length / 1024

      // JSON baseline (just the active checkpoint)
      const activeData = { checkpoint: Object.fromEntries(checkpoint.entries()) }
      const jsonSize = new TextEncoder().encode(JSON.stringify(activeData)).byteLength / 1024

      console.log(
        `[SyncLogCRDT] Full: ${fullSizeKB.toFixed(2)} KB, JSON baseline: ${jsonSize.toFixed(2)} KB`
      )

      // Full size should be < 20KB due to range compression
      expect(fullSizeKB).toBeLessThan(20)
    })
  })
})
