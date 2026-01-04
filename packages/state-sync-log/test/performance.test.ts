import { describe, it } from "vitest"
import { SyncLogDoc } from "../src/crdt/SyncLogDoc"
import { createStateSyncLog } from "../src/index"
import { Op } from "../src/operations"
import { applyLocalCheckpoint } from "./utils"

describe("Performance", () => {
  // Use 1000 for fast CI. Increase to 10000+ for stress testing.
  const iterations = 10000

  it(`measures performance of ${iterations} 10 array pushes`, () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

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

    reportDocSize(`Without checkpointing ${iterations} 10 array pushes`, doc, log.getState())
  }, 60000) // 60s timeout

  it(`measures performance of ${iterations} 10 random updates on an object with 1000 keys`, () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: undefined,
    })

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

    reportDocSize(
      `Without checkpointing ${iterations} 10 random updates on an object with 1000 keys`,
      doc,
      log.getState()
    )
  }, 60000)

  function reportDocSize(label: string, doc: SyncLogDoc, state: unknown) {
    const update = doc.encodeStateAsUpdate()
    const syncLogSize = JSON.stringify(update).length
    const jsonSize = JSON.stringify(state).length

    console.log(
      `[${label}] SyncLogDoc size: ${(syncLogSize / 1024).toFixed(2)} KB, JSON size: ${(jsonSize / 1024).toFixed(2)} KB, SyncLogDoc/JSON ratio: ${(syncLogSize / jsonSize).toFixed(2)}x`
    )
    return { syncLogSize, jsonSize }
  }

  it(`measures performance of ${iterations} 10 random updates with periodic checkpointing`, () => {
    const doc = new SyncLogDoc()
    const log = createStateSyncLog<any>({
      syncLogDoc: doc,
      retentionWindowMs: 0,
    })

    const initOps = []
    for (let i = 0; i < 1000; i++) {
      initOps.push({ kind: "set" as const, path: [], key: `key_${i}`, value: i })
    }
    log.emit(initOps)
    applyLocalCheckpoint(log)

    for (let i = 0; i < iterations; i++) {
      const ops: Op[] = []
      for (let j = 0; j < 10; j++) {
        const keyIndex = Math.floor(Math.random() * 1000)
        ops.push({ kind: "set" as const, path: [], key: `key_${keyIndex}`, value: i * 10 + j })
      }
      log.emit(ops)

      if ((i + 1) % 100 === 0) {
        applyLocalCheckpoint(log)
      }
    }

    console.log(
      `Active epoch: ${log.getActiveEpoch()}, Tx count in epoch: ${log.getActiveEpochTxCount()}`
    )

    reportDocSize(
      `With checkpointing ${iterations} 10 random updates on an object with 1000 keys`,
      doc,
      log.getState()
    )
  }, 60000)
})
