import { describe, it } from "vitest"
import * as Y from "yjs"
import { createStateSyncLog } from "../src/index"

describe("Performance", () => {
  // Use 1000 for fast CI. Increase to 10000+ for stress testing.
  const iterations = 10000

  it(`measures performance of ${iterations} 10 array pushes`, () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    // Initialize array
    log.emit([{ kind: "set", path: [], key: "list", value: [] }])

    let listIndex = 0
    for (let i = 0; i < iterations; i++) {
      const ops = []
      for (let j = 0; j < 10; j++) {
        ops.push({
          kind: "splice" as const,
          path: ["list"],
          index: listIndex,
          deleteCount: 0,
          inserts: [i + j],
        })
        listIndex++
      }
      log.emit(ops)
    }
  }, 60000) // 60s timeout

  it(`measures performance of ${iterations} 10 random updates on an object with 1000 keys`, () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: undefined })

    // Initialize with 1000 keys
    const initOps = []
    for (let i = 0; i < 1000; i++) {
      initOps.push({ kind: "set" as const, path: [], key: `key_${i}`, value: i })
    }
    log.emit(initOps)

    for (let i = 0; i < iterations; i++) {
      const ops = []
      for (let j = 0; j < 10; j++) {
        const keyIndex = Math.floor(Math.random() * 1000)
        ops.push({ kind: "set" as const, path: [], key: `key_${keyIndex}`, value: i * 10 + j })
      }
      log.emit(ops)
    }
  }, 60000)

  function reportDocSize(label: string, doc: Y.Doc, state: unknown) {
    const update = Y.encodeStateAsUpdateV2(doc)
    const jsonSize = new TextEncoder().encode(JSON.stringify(state)).byteLength

    // Round-trip through a fresh doc to trigger GC
    const freshDoc = new Y.Doc()
    Y.applyUpdateV2(freshDoc, update)
    const afterGcSize = Y.encodeStateAsUpdateV2(freshDoc).byteLength

    console.log(
      `[${label}] Yjs size: ${(afterGcSize / 1024).toFixed(2)} KB, JSON size: ${(jsonSize / 1024).toFixed(2)} KB, Yjs/JSON ratio: ${(afterGcSize / jsonSize).toFixed(2)}x`
    )
    return { afterGcSize, jsonSize }
  }

  it(`measures performance of ${iterations} 10 random updates with periodic compaction`, () => {
    const doc = new Y.Doc()
    const log = createStateSyncLog<any>({ yDoc: doc, retentionWindowMs: 0 })

    // Pure Yjs for comparison
    const pureDoc = new Y.Doc()
    const yMap = pureDoc.getMap<number>("root")

    // Initialize with 1000 keys
    const initOps = []
    for (let i = 0; i < 1000; i++) {
      initOps.push({ kind: "set" as const, path: [], key: `key_${i}`, value: i })
      yMap.set(`key_${i}`, i)
    }
    log.emit(initOps)
    log.compact()

    for (let i = 0; i < iterations; i++) {
      const ops = []
      for (let j = 0; j < 10; j++) {
        const keyIndex = Math.floor(Math.random() * 1000)
        ops.push({ kind: "set" as const, path: [], key: `key_${keyIndex}`, value: i * 10 + j })
        yMap.set(`key_${keyIndex}`, i * 10 + j)
      }
      log.emit(ops)

      if ((i + 1) % 100 === 0) {
        log.compact()
      }
    }

    console.log(
      `Active epoch: ${log.getActiveEpoch()}, Tx count in epoch: ${log.getActiveEpochTxCount()}`
    )

    // Diagnostic: measure individual Yjs map sizes
    const yTx = doc.getMap("state-sync-log-tx")
    const yCheckpoint = doc.getMap("state-sync-log-checkpoint")
    const txDoc = new Y.Doc()
    const cpDoc = new Y.Doc()
    for (const [k, v] of yTx.entries()) txDoc.getMap("m").set(k, v)
    for (const [k, v] of yCheckpoint.entries()) cpDoc.getMap("m").set(k, v)
    console.log(
      `Yjs tx log size: ${(Y.encodeStateAsUpdateV2(txDoc).byteLength / 1024).toFixed(2)} KB (${yTx.size} entries)`
    )
    console.log(
      `Yjs checkpoint size: ${(Y.encodeStateAsUpdateV2(cpDoc).byteLength / 1024).toFixed(2)} KB (${yCheckpoint.size} entries)`
    )

    const sslResult = reportDocSize("state-sync-log", doc, log.getState())
    const pureResult = reportDocSize("pure Yjs", pureDoc, yMap.toJSON())
    console.log(`Overhead: ${(sslResult.afterGcSize / pureResult.afterGcSize).toFixed(2)}x`)
  }, 60000)
})
