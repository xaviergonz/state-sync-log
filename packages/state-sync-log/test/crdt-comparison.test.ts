import * as Automerge from "@automerge/automerge"
import { Model } from "json-joy/lib/json-crdt"
import { LoroDoc } from "loro-crdt"
import { describe, it } from "vitest"
import * as Y from "yjs"

/**
 * Custom Mini-CRDT: LWW-Map (Last-Writer-Wins Map)
 *
 * Optimized for the state-sync-log use case:
 * - Only supports set(key, value) and delete(key)
 * - Values are immutable (never mutated, only replaced)
 * - Uses Lamport timestamps for conflict resolution
 * - Compact binary encoding
 */
class MiniCRDT {
  private clientId: string
  private clock = 0

  // Storage
  // maps.get(name).active.get(key) -> { value, clock, clientId }
  // maps.get(name).tombstones.get(key) -> { clock, clientId }
  private maps: Map<
    string,
    {
      active: Map<string, { value: unknown; clock: number; clientId: string }>
      tombstones: Map<string, { clock: number; clientId: string }>
    }
  > = new Map()

  // Dictionary for client IDs to compress them into integers
  private clientIds: string[] = []
  private clientIdMap: Map<string, number> = new Map()

  constructor(clientId: string = "client_" + Math.random().toString(36).slice(2, 8)) {
    this.clientId = clientId
    this.registerClient(clientId)
  }

  registerClient(id: string): number {
    let idx = this.clientIdMap.get(id)
    if (idx === undefined) {
      idx = this.clientIds.length
      this.clientIds.push(id)
      this.clientIdMap.set(id, idx)
    }
    return idx
  }

  getMap(name: string): MiniMap {
    if (!this.maps.has(name)) {
      this.maps.set(name, { active: new Map(), tombstones: new Map() })
    }
    return new MiniMap(this, this.maps.get(name)!)
  }

  nextClock(): number {
    return ++this.clock
  }

  getClock(): number {
    return this.clock
  }

  getClientId(): string {
    return this.clientId
  }

  // Optimized Encode: Columnar arrays with Delta Encoding & RLE
  // Output format: [clientDictionary, mapData]
  // mapData: { mapName: [activeColumns, tombstoneColumns] }
  // activeColumns: [keys, values, deltaClocks, rleClients]
  // tombstoneColumns: [keys, deltaClocks, rleClients]
  encode(): Uint8Array {
    return this.internalEncode(false)
  }

  encodeWithTombstones(): Uint8Array {
    return this.internalEncode(true)
  }

  // Garbage Collection: Prune tombstones older than minClock
  gc(minClock: number): void {
    for (const store of this.maps.values()) {
      for (const [key, entry] of store.tombstones) {
        if (entry.clock < minClock) {
          store.tombstones.delete(key)
        }
      }
    }
  }

  private internalEncode(includeTombstones: boolean): Uint8Array {
    const mapData: Record<string, unknown> = {}

    for (const [name, store] of this.maps) {
      // Active columns (Set-Once Optimization: No Clocks, No ClientID)
      const aKeys: string[] = []
      const aValues: unknown[] = []

      for (const [key, entry] of store.active) {
        aKeys.push(key)
        aValues.push(entry.value)
      }

      const activeCols = aKeys.length > 0 ? [aKeys, aValues] : []

      let tombstoneCols: unknown[] = []

      // Tombstone columns (Range Optimized)
      if (includeTombstones) {
        const rawKeys: string[] = []
        const ranges: Record<string, number[]> = {} // clientId -> [seq...]

        for (const [key] of store.tombstones) {
          // Try to parse "CLIENT;SEQ;;META"
          const parts = key.split(";;")
          if (parts.length >= 2) {
            const identity = parts[0]
            const lastSemi = identity.lastIndexOf(";")
            if (lastSemi > 0) {
              const prefix = identity.slice(0, lastSemi)
              const seqStr = identity.slice(lastSemi + 1)
              const seq = Number.parseInt(seqStr, 10)

              if (!Number.isNaN(seq)) {
                if (!ranges[prefix]) ranges[prefix] = []
                ranges[prefix].push(seq)
                continue
              }
            }
          }
          rawKeys.push(key)
        }

        // Process ranges [prefix, [start1, end1, start2, end2]]
        const encodedRanges: unknown[] = []
        for (const [prefix, seqs] of Object.entries(ranges)) {
          if (seqs.length === 0) continue
          // Sort integers
          seqs.sort((a, b) => a - b)

          const clientRanges: number[] = []
          let start = seqs[0]
          let prev = seqs[0]

          for (let i = 1; i < seqs.length; i++) {
            if (seqs[i] === prev + 1) {
              prev = seqs[i]
            } else {
              clientRanges.push(start, prev)
              start = seqs[i]
              prev = seqs[i]
            }
          }
          clientRanges.push(start, prev)
          // Use Delta Encoding on the ranges to squeeze it further
          encodedRanges.push([prefix, this.encodeDeltas(clientRanges)])
        }

        if (rawKeys.length > 0 || encodedRanges.length > 0) {
          tombstoneCols = [encodedRanges, rawKeys]
        }
      }

      if (activeCols.length > 0 || tombstoneCols.length > 0) {
        mapData[name] = [activeCols, tombstoneCols]
      }
    }

    // Structure: [ClientDictionary, Maps]
    const payload = [this.clientIds, mapData]
    return new TextEncoder().encode(JSON.stringify(payload))
  }

  // Delta Encoding: [start, delta1, delta2, ...]
  private encodeDeltas(numbers: number[]): number[] {
    if (numbers.length === 0) return []
    const deltas: number[] = [numbers[0]]
    for (let i = 1; i < numbers.length; i++) {
      deltas.push(numbers[i] - numbers[i - 1])
    }
    return deltas
  }
}

class MiniMap {
  constructor(
    private crdt: MiniCRDT,
    private store: {
      active: Map<string, { value: unknown; clock: number; clientId: string }>
      tombstones: Map<string, { clock: number; clientId: string }>
    }
  ) {}

  set(key: string, value: unknown): void {
    const clock = this.crdt.nextClock()
    const clientId = this.crdt.getClientId()

    // Check vs Active
    const existingActive = this.store.active.get(key)
    if (existingActive) {
      if (
        clock > existingActive.clock ||
        (clock === existingActive.clock && clientId > existingActive.clientId)
      ) {
        this.store.active.set(key, { value, clock, clientId })
      }
      return
    }

    // Check vs Tombstones
    const existingTomb = this.store.tombstones.get(key)
    if (existingTomb) {
      if (
        clock > existingTomb.clock ||
        (clock === existingTomb.clock && clientId > existingTomb.clientId)
      ) {
        this.store.tombstones.delete(key) // Resurrect
        this.store.active.set(key, { value, clock, clientId })
      }
      return
    }

    // New key
    this.store.active.set(key, { value, clock, clientId })
  }

  delete(key: string): void {
    const clock = this.crdt.nextClock()
    const clientId = this.crdt.getClientId()

    // Check vs Active
    const existingActive = this.store.active.get(key)
    if (existingActive) {
      if (
        clock > existingActive.clock ||
        (clock === existingActive.clock && clientId > existingActive.clientId)
      ) {
        this.store.active.delete(key)
        this.store.tombstones.set(key, { clock, clientId })
      }
      return
    }

    // Check vs Tombstones (update tombstone timestamp if newer)
    const existingTomb = this.store.tombstones.get(key)
    if (existingTomb) {
      if (
        clock > existingTomb.clock ||
        (clock === existingTomb.clock && clientId > existingTomb.clientId)
      ) {
        this.store.tombstones.set(key, { clock, clientId })
      }
      return
    }

    // New deletion (of unknown key)
    this.store.tombstones.set(key, { clock, clientId })
  }

  get size(): number {
    return this.store.active.size
  }
}

/**
 * This test compares document sizes across different CRDT libraries.
 *
 * The test simulates the state-sync-log pattern:
 * 1. Set X transaction keys in a "tx" map
 * 2. Set a checkpoint key in a "checkpoint" map with the current state
 * 3. Delete all transaction keys (simulating compaction)
 *
 * We measure the final document size after GC/compaction.
 */
describe("CRDT Library Size Comparison", () => {
  // Number of transactions before compaction
  const txCount = 100
  // Number of compaction cycles
  const compactionCycles = 100
  // Size of checkpoint state (1000 keys)
  const stateKeyCount = 1000

  function generateCheckpointState(): Record<string, number> {
    const state: Record<string, number> = {}
    for (let i = 0; i < stateKeyCount; i++) {
      state[`key_${i}`] = Math.floor(Math.random() * 100000)
    }
    return state
  }

  function generateTxRecord(index: number): {
    ops: Array<{ kind: string; key: string; value: number }>
  } {
    return {
      ops: [{ kind: "set", key: `key_${index % stateKeyCount}`, value: index }],
    }
  }

  it("Yjs - Map with set/delete and checkpoint", () => {
    const doc = new Y.Doc()
    const yTx = doc.getMap<unknown>("tx")
    const yCheckpoint = doc.getMap<unknown>("checkpoint")

    for (let cycle = 0; cycle < compactionCycles; cycle++) {
      const txKeys: string[] = []

      // Add transactions
      for (let i = 0; i < txCount; i++) {
        const txKey = `clientA;${cycle * txCount + i};;${cycle};123456789`
        txKeys.push(txKey)
        yTx.set(txKey, generateTxRecord(cycle * txCount + i))
      }

      // Create checkpoint
      const checkpointKey = `clientA;${cycle};;${txCount}`
      yCheckpoint.set(checkpointKey, {
        state: generateCheckpointState(),
        watermarks: { clientA: { maxClock: cycle * txCount + txCount, maxWallClock: Date.now() } },
        txCount,
      })

      // Delete old checkpoint
      if (cycle > 0) {
        yCheckpoint.delete(`clientA;${cycle - 1};;${txCount}`)
      }

      // Delete all transactions (compaction)
      for (const txKey of txKeys) {
        yTx.delete(txKey)
      }
    }

    // Measure size
    const update = Y.encodeStateAsUpdateV2(doc)

    // Round-trip to trigger GC
    const freshDoc = new Y.Doc()
    Y.applyUpdateV2(freshDoc, update)
    const afterGcSize = Y.encodeStateAsUpdateV2(freshDoc).byteLength

    console.log(
      `[Yjs] Final size: ${(afterGcSize / 1024).toFixed(2)} KB (tx: ${yTx.size}, checkpoint: ${yCheckpoint.size})`
    )
  })

  it("Loro - Map with set/delete and checkpoint", () => {
    const doc = new LoroDoc()
    const loroTx = doc.getMap("tx")
    const loroCheckpoint = doc.getMap("checkpoint")

    for (let cycle = 0; cycle < compactionCycles; cycle++) {
      const txKeys: string[] = []

      // Add transactions
      for (let i = 0; i < txCount; i++) {
        const txKey = `clientA;${cycle * txCount + i};;${cycle};123456789`
        txKeys.push(txKey)
        loroTx.set(txKey, generateTxRecord(cycle * txCount + i))
      }

      // Create checkpoint
      const checkpointKey = `clientA;${cycle};;${txCount}`
      loroCheckpoint.set(checkpointKey, {
        state: generateCheckpointState(),
        watermarks: { clientA: { maxClock: cycle * txCount + txCount, maxWallClock: Date.now() } },
        txCount,
      })

      // Delete old checkpoint
      if (cycle > 0) {
        loroCheckpoint.delete(`clientA;${cycle - 1};;${txCount}`)
      }

      // Delete all transactions (compaction)
      for (const txKey of txKeys) {
        loroTx.delete(txKey)
      }
    }

    // Measure size with different export modes
    const snapshotSize = doc.export({ mode: "snapshot" }).byteLength
    // shallow-snapshot requires frontiers to specify which version to export
    const shallowSnapshotSize = doc.export({
      mode: "shallow-snapshot",
      frontiers: doc.frontiers(),
    }).byteLength
    console.log(
      `[Loro] Snapshot: ${(snapshotSize / 1024).toFixed(2)} KB, Shallow (GC'd): ${(shallowSnapshotSize / 1024).toFixed(2)} KB (tx: ${loroTx.size}, checkpoint: ${loroCheckpoint.size})`
    )
  })

  it("Automerge - Map with set/delete and checkpoint", () => {
    type DocType = {
      tx: Record<string, unknown>
      checkpoint: Record<string, unknown>
    }

    let doc = Automerge.init<DocType>()
    doc = Automerge.change(doc, (d) => {
      d.tx = {}
      d.checkpoint = {}
    })

    for (let cycle = 0; cycle < compactionCycles; cycle++) {
      const txKeys: string[] = []

      doc = Automerge.change(doc, (d) => {
        // Add transactions
        for (let i = 0; i < txCount; i++) {
          const txKey = `clientA;${cycle * txCount + i};;${cycle};123456789`
          txKeys.push(txKey)
          d.tx[txKey] = generateTxRecord(cycle * txCount + i)
        }

        // Create checkpoint
        const checkpointKey = `clientA;${cycle};;${txCount}`
        d.checkpoint[checkpointKey] = {
          state: generateCheckpointState(),
          watermarks: {
            clientA: { maxClock: cycle * txCount + txCount, maxWallClock: Date.now() },
          },
          txCount,
        }

        // Delete old checkpoint
        if (cycle > 0) {
          delete d.checkpoint[`clientA;${cycle - 1};;${txCount}`]
        }

        // Delete all transactions (compaction)
        for (const txKey of txKeys) {
          delete d.tx[txKey]
        }
      })
    }

    // Measure size - save() includes compacted history
    const bytes = Automerge.save(doc)
    // clone() creates a fresh document without full history
    const clonedDoc = Automerge.clone(doc)
    const clonedBytes = Automerge.save(clonedDoc)
    console.log(
      `[Automerge] Full: ${(bytes.byteLength / 1024).toFixed(2)} KB, Cloned: ${(clonedBytes.byteLength / 1024).toFixed(2)} KB (tx: ${Object.keys(doc.tx).length}, checkpoint: ${Object.keys(doc.checkpoint).length})`
    )
  }, 60000)

  it("json-joy - Map with set/delete and checkpoint", () => {
    const model = Model.create()

    // Initialize structure
    model.api.root({
      tx: {},
      checkpoint: {},
    })

    for (let cycle = 0; cycle < compactionCycles; cycle++) {
      const txKeys: string[] = []

      // Add transactions
      for (let i = 0; i < txCount; i++) {
        const txKey = `clientA;${cycle * txCount + i};;${cycle};123456789`
        txKeys.push(txKey)
        model.api.obj(["tx"]).set({ [txKey]: generateTxRecord(cycle * txCount + i) })
      }

      // Create checkpoint
      const checkpointKey = `clientA;${cycle};;${txCount}`
      model.api.obj(["checkpoint"]).set({
        [checkpointKey]: {
          state: generateCheckpointState(),
          watermarks: {
            clientA: { maxClock: cycle * txCount + txCount, maxWallClock: Date.now() },
          },
          txCount,
        },
      })

      // Delete old checkpoint
      if (cycle > 0) {
        model.api.obj(["checkpoint"]).del([`clientA;${cycle - 1};;${txCount}`])
      }

      // Delete all transactions (compaction)
      model.api.obj(["tx"]).del(txKeys)
    }

    // Measure size
    const blob = model.toBinary()
    const view = model.view() as {
      tx: Record<string, unknown>
      checkpoint: Record<string, unknown>
    }
    console.log(
      `[json-joy] Final size: ${(blob.byteLength / 1024).toFixed(2)} KB (tx: ${Object.keys(view.tx).length}, checkpoint: ${Object.keys(view.checkpoint).length})`
    )
  })

  it("Mini-CRDT (custom LWW-Map) - Map with set/delete and checkpoint", () => {
    const doc = new MiniCRDT("clientA")
    const miniTx = doc.getMap("tx")
    const miniCheckpoint = doc.getMap("checkpoint")

    let offlinePeerClock: number | undefined

    for (let cycle = 0; cycle < compactionCycles; cycle++) {
      const txKeys: string[] = []

      // Add transactions
      for (let i = 0; i < txCount; i++) {
        const txKey = `clientA;${cycle * txCount + i};;${cycle};123456789`
        txKeys.push(txKey)
        miniTx.set(txKey, generateTxRecord(cycle * txCount + i))
      }

      // Create checkpoint
      const checkpointKey = `clientA;${cycle};;${txCount}`
      miniCheckpoint.set(checkpointKey, {
        state: generateCheckpointState(),
        watermarks: {
          clientA: { maxClock: cycle * txCount + txCount, maxWallClock: Date.now() },
        },
        txCount,
      })

      // Delete old checkpoint
      if (cycle > 0) {
        miniCheckpoint.delete(`clientA;${cycle - 1};;${txCount}`)
      }

      // Delete all transactions (compaction)
      for (const txKey of txKeys) {
        miniTx.delete(txKey)
      }

      // Simulate "Safe GC" (like Yjs)
      // Peer B goes offline at Cycle 10.
      if (cycle === 10) {
        offlinePeerClock = doc.getClock()
      }

      // We can only GC tombstones that ALL peers have seen.
      // If cycle < 10, everyone is synced (GC up to now).
      // If cycle >= 10, Peer B is lagging. We can only GC up to offlinePeerClock.
      const safeScanClock = cycle < 10 ? doc.getClock() : offlinePeerClock!

      doc.gc(safeScanClock)
    }

    // Measure size with Lagging Peer
    const sizeWithLag = doc.encodeWithTombstones().byteLength

    // Peer B comes back online and syncs!
    doc.gc(doc.getClock())
    const sizeFullySynced = doc.encodeWithTombstones().byteLength

    const snapshotSize = doc.encode().byteLength

    console.log(
      `[Mini-CRDT] Snapshot: ${(snapshotSize / 1024).toFixed(2)} KB
       - With Offline Peer (90 cycles lag): ${(sizeWithLag / 1024).toFixed(2)} KB
       - Fully Synced (All peers caught up): ${(sizeFullySynced / 1024).toFixed(2)} KB`
    )
  })

  it("Summary - JSON baseline (theoretical minimum)", () => {
    // What would the data look like as pure JSON?
    const data = {
      tx: {} as Record<string, unknown>,
      checkpoint: {
        [`${compactionCycles - 1}_${txCount}_clientA`]: {
          state: generateCheckpointState(),
          watermarks: {
            clientA: { maxClock: compactionCycles * txCount, maxWallClock: Date.now() },
          },
          txCount,
        },
      },
    }

    const jsonSize = new TextEncoder().encode(JSON.stringify(data)).byteLength
    console.log(`[JSON baseline] Size: ${(jsonSize / 1024).toFixed(2)} KB`)
  })
})
