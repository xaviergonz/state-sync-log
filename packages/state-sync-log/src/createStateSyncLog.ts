import { CheckpointRecord, createCheckpoint } from "./checkpoints"
import { createClientState } from "./clientState"
import { SyncLogDoc } from "./crdt/SyncLogDoc"
import { SyncLogMapEvent } from "./crdt/SyncLogMap"
import { failure } from "./error"
import { JSONObject } from "./json"

import { Op, ValidateFn } from "./operations"

import { computeReconcileOps } from "./reconcile"
import { SortedTxEntry } from "./SortedTxEntry"
import { TxRecord } from "./TxRecord"
import { appendTx, TxKeyChanges, updateState } from "./txLog"
import { TxTimestampKey } from "./txTimestamp"
import { generateID } from "./utils"

export const getSortedTxsSymbol = Symbol("getSortedTxs")

export interface StateSyncLogOptions<State extends JSONObject> {
  /**
   * The SyncLogDoc to bind to.
   */
  syncLogDoc: SyncLogDoc

  /**
   * Name for the txs map.
   * Default: "state-sync-log-tx"
   */
  txMapName?: string

  /**
   * Name for the checkpoint map.
   * Default: "state-sync-log-checkpoint"
   */
  checkpointMapName?: string

  /**
   * Unique identifier for this client.
   * If omitted, a random UUID (nanoid) will be generated.
   * NOTE: If you need to resume a session (keep local clock/watermark), you MUST provide a stable ID.
   * MUST NOT contain semicolons.
   */
  clientId?: string

  /**
   * Optional validation function.
   * Runs after each tx's ops are applied.
   * If it returns false, the tx is rejected (state reverts).
   * MUST be deterministic and consistent across all clients.
   */
  validate?: (state: State) => boolean

  /**
   * Timestamp retention window in milliseconds.
   * Txs older than this window are considered "Ancient" and pruned.
   *
   * Default: Infinity (No pruning).
   * Recommended: 14 days (1209600000 ms).
   */
  retentionWindowMs: number | undefined

  /**
   * Origin value passed to transact() calls.
   * This is emitted with update events and can be used to identify the source of changes.
   */
  origin?: unknown
}

export interface StateSyncLogController<State extends JSONObject> {
  /**
   * Returns the current state.
   */
  getState(): State

  /**
   * Subscribes to state changes.
   */
  subscribe(callback: (newState: State, getAppliedOps: () => readonly Op[]) => void): () => void

  /**
   * Emits a new tx (list of operations) to the log.
   */
  emit(ops: Op[]): void

  /**
   * Reconciles the current state with the target state.
   */
  reconcileState(targetState: State): void

  /**
   * Manually triggers epoch compaction (Checkpointing).
   */
  compact(): void

  /**
   * Cleans up observers and releases memory.
   */
  dispose(): void

  // --- Observability & Stats ---

  /**
   * Returns the current active epoch number.
   */
  getActiveEpoch(): number

  /**
   * Returns the number of txs currently in the active epoch.
   */
  getActiveEpochTxCount(): number

  /**
   * Returns the wallClock timestamp of the first tx in the active epoch.
   */
  getActiveEpochStartTime(): number | undefined

  /**
   * Returns true if the log is completely empty.
   */
  isLogEmpty(): boolean

  /**
   * Internal/Testing: Returns all txs currently in the log, sorted.
   */
  [getSortedTxsSymbol](): readonly SortedTxEntry[]
}

/**
 * Creates a StateSyncLog controller.
 */
export function createStateSyncLog<State extends JSONObject>(
  options: StateSyncLogOptions<State>
): StateSyncLogController<State> {
  const {
    syncLogDoc,
    txMapName = "state-sync-log-tx",
    checkpointMapName = "state-sync-log-checkpoint",
    clientId = generateID(),
    validate,
    retentionWindowMs,
    origin,
  } = options

  if (clientId.includes(";")) {
    failure(`clientId MUST NOT contain semicolons: ${clientId}`)
  }

  const txMap = syncLogDoc.getMap<TxRecord>(txMapName)
  const checkpointMap = syncLogDoc.getMap<CheckpointRecord>(checkpointMapName)

  // Cast validate to basic type to match internal ClientState
  const clientState = createClientState(
    validate as unknown as ValidateFn<JSONObject>,
    retentionWindowMs ?? Number.POSITIVE_INFINITY
  )

  // Listeners
  const subscribers = new Set<(state: State, getAppliedOps: () => readonly Op[]) => void>()

  const notifySubscribers = (state: State, getAppliedOps: () => readonly Op[]) => {
    for (const sub of subscribers) {
      sub(state, getAppliedOps)
    }
  }

  // Helper to extract key changes from SyncLogMapEvent
  const extractTxChanges = (event: SyncLogMapEvent<TxRecord>): TxKeyChanges => {
    const added: TxTimestampKey[] = []
    const deleted: TxTimestampKey[] = []

    for (const [key, change] of event.changes.keys) {
      if (change.action === "add") {
        added.push(key)
      } else if (change.action === "delete") {
        deleted.push(key)
      }
    }

    return { added, deleted }
  }

  // Empty txChanges object for checkpoint observer (no tx keys changed)
  const emptyTxChanges: TxKeyChanges = { added: [], deleted: [] }

  // Update Logic with incremental changes
  const runUpdate = (txChanges: TxKeyChanges | undefined) => {
    const { state, getAppliedOps } = updateState(
      syncLogDoc,
      txMap,
      checkpointMap,
      clientId,
      clientState,
      txChanges
    )
    notifySubscribers(state as State, getAppliedOps)
  }

  // Tx observer
  const txObserver = (event: SyncLogMapEvent<TxRecord>, _origin: unknown) => {
    const txChanges = extractTxChanges(event)
    runUpdate(txChanges)
  }

  // Checkpoint observer
  const checkpointObserver = (_event: SyncLogMapEvent<CheckpointRecord>, _origin: unknown) => {
    runUpdate(emptyTxChanges)
  }

  const disposeCheckpointObserver = checkpointMap.observe(checkpointObserver)
  const disposeTxObserver = txMap.observe(txObserver)

  // Initial run (full recompute, treat as checkpoint change to initialize epoch cache)
  runUpdate(undefined)

  // Track disposal state
  let disposed = false

  const assertNotDisposed = () => {
    if (disposed) {
      failure("StateSyncLog has been disposed and cannot be used")
    }
  }

  const getActiveEpochInternal = () => {
    if (clientState.cachedFinalizedEpoch === null) {
      failure("cachedFinalizedEpoch is null - this should not happen after initialization")
    }
    return clientState.cachedFinalizedEpoch + 1
  }

  return {
    getState(): State {
      assertNotDisposed()
      return (clientState.stateCalculator.getCachedState() ?? {}) as State
    },

    subscribe(callback: (newState: State, getAppliedOps: () => readonly Op[]) => void): () => void {
      assertNotDisposed()
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },

    emit(ops: Op[]): void {
      assertNotDisposed()
      syncLogDoc.transact(() => {
        const activeEpoch = getActiveEpochInternal()
        appendTx(ops, txMap, activeEpoch, clientId, clientState)
      }, origin)
    },

    reconcileState(targetState: State): void {
      assertNotDisposed()
      const currentState = (clientState.stateCalculator.getCachedState() ?? {}) as State
      const ops = computeReconcileOps(currentState, targetState)
      if (ops.length > 0) {
        this.emit(ops)
      }
    },

    compact(): void {
      assertNotDisposed()
      syncLogDoc.transact(() => {
        const activeEpoch = getActiveEpochInternal()
        const currentState = clientState.stateCalculator.getCachedState() ?? {}
        createCheckpoint(txMap, checkpointMap, clientState, activeEpoch, currentState, clientId)
      }, origin)
    },

    dispose(): void {
      if (disposed) return // Already disposed, no-op
      disposed = true
      disposeTxObserver()
      disposeCheckpointObserver()
      subscribers.clear()
    },

    getActiveEpoch(): number {
      assertNotDisposed()
      return getActiveEpochInternal()
    },

    getActiveEpochTxCount(): number {
      assertNotDisposed()
      const activeEpoch = getActiveEpochInternal()
      let count = 0
      // Only current or future epochs exist in sortedTxs (past epochs are pruned during updateState).
      // Future epochs appear if we receive txs before the corresponding checkpoint.
      for (const entry of clientState.stateCalculator.getSortedTxs()) {
        const ts = entry.txTimestamp
        if (ts.epoch === activeEpoch) {
          count++
        } else if (ts.epoch > activeEpoch) {
          break // Optimization: sorted order means we can stop early
        }
      }
      return count
    },

    getActiveEpochStartTime(): number | undefined {
      assertNotDisposed()
      const activeEpoch = getActiveEpochInternal()
      // Only current or future epochs exist in sortedTxs (past epochs are pruned during updateState).
      for (const entry of clientState.stateCalculator.getSortedTxs()) {
        const ts = entry.txTimestamp
        if (ts.epoch === activeEpoch) {
          return ts.wallClock
        } else if (ts.epoch > activeEpoch) {
          break // Optimization: sorted order means we can stop early
        }
      }
      return undefined
    },

    isLogEmpty(): boolean {
      assertNotDisposed()
      return txMap.size === 0 && checkpointMap.size === 0
    },

    [getSortedTxsSymbol](): readonly SortedTxEntry[] {
      assertNotDisposed()
      return clientState.stateCalculator.getSortedTxs()
    },
  }
}
