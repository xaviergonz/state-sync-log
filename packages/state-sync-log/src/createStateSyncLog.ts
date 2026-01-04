import { CheckpointRecord, createCheckpoint } from "./checkpoints"
import { createClientState } from "./clientState"
import { SyncLogDoc } from "./crdt/SyncLogDoc"
import { SyncLogMapEvent } from "./crdt/SyncLogMap"
import { failure } from "./error"
import { JSONObject } from "./json"

import { Op, ValidateFn } from "./operations"

import { computeReconcileOps } from "./reconcile"
import { SortedTxEntry } from "./SortedTxEntry"
import { EncodedTxRecord } from "./TxRecordCompression"
import { appendTx, TxKeyChanges, updateState } from "./txLog"
import { TxTimestampKey } from "./txTimestamp"
import { generateID } from "./utils"

export const getSortedTxsSymbol = Symbol("getSortedTxs")

/**
 * Parameters passed to the autoCompact callback.
 */
export interface AutoCompactParams {
  /**
   * Transaction log statistics for the current epoch.
   */
  txLog: {
    /**
     * Number of transactions in the current epoch.
     */
    size: number
    /**
     * Total number of operations across all transactions in the current epoch.
     */
    ops: number
  }
  /**
   * Timestamp (Date.now()) of the last checkpoint arrival, or undefined if no checkpoint exists yet.
   */
  lastCompactionTime: number | undefined
}

/**
 * Default auto-compaction strategy.
 * Compacts when:
 * - 100+ transactions OR 1000+ operations in the current epoch
 * - OR 5+ minutes have passed since the last compaction (if there's something to compact)
 */
export const defaultAutoCompact = ({ txLog, lastCompactionTime }: AutoCompactParams): boolean => {
  // Compact if log is getting large
  if (txLog.size >= 100 || txLog.ops >= 1000) return true

  // Compact after 5 minutes if there's something to compact
  if (
    txLog.size > 0 &&
    lastCompactionTime !== undefined &&
    Date.now() - lastCompactionTime >= 5 * 60 * 1000
  ) {
    return true
  }

  return false
}

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

  /**
   * Callback to determine if automatic compaction should occur.
   * Called after each state update when transactions are added.
   * If it returns true, `compact()` is called automatically.
   *
   * By default, uses `defaultAutoCompact` which compacts when:
   * - 100+ transactions OR 1000+ operations in the current epoch
   * - OR 5+ minutes have passed since the last compaction
   *
   * Pass `() => false` to disable auto-compaction entirely.
   *
   * @example
   * ```ts
   * // Custom: Compact after 50 transactions or 500 ops or 2 minutes
   * autoCompact: ({ txLog, lastCompactionTime }) =>
   *   txLog.size >= 50 ||
   *   txLog.ops >= 500 ||
   *   (lastCompactionTime !== undefined && Date.now() - lastCompactionTime >= 2 * 60 * 1000)
   * ```
   */
  autoCompact?: (params: AutoCompactParams) => boolean
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
   * Returns the total number of operations across all txs in the active epoch.
   */
  getActiveEpochOpsCount(): number

  /**
   * Returns the wallClock timestamp of the first tx in the active epoch.
   */
  getActiveEpochStartTime(): number | undefined

  /**
   * Returns the timestamp (Date.now()) of the last checkpoint change, or undefined if no checkpoint exists yet
   * or the log was just initialized.
   */
  getLastCompactionTime(): number | undefined

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
    autoCompact = defaultAutoCompact,
  } = options

  if (clientId.includes(";")) {
    failure(`clientId MUST NOT contain semicolons: ${clientId}`)
  }

  const txMap = syncLogDoc.getMap<EncodedTxRecord>(txMapName)
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
  const extractTxChanges = (event: SyncLogMapEvent<EncodedTxRecord>): TxKeyChanges => {
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

  // Track when the last checkpoint arrived (undefined if none yet)
  let lastCheckpointTime: number | undefined

  // Flag to prevent recursive auto-compact
  let isAutoCompacting = false

  // Update Logic with incremental changes
  const runUpdate = (txChanges: TxKeyChanges | undefined, isCheckpointChange: boolean) => {
    const { state, getAppliedOps } = updateState(
      syncLogDoc,
      txMap,
      checkpointMap,
      clientId,
      clientState,
      txChanges
    )

    // Update checkpoint arrival time only when a checkpoint actually exists
    if (
      isCheckpointChange &&
      clientState.cachedFinalizedEpoch !== null &&
      clientState.cachedFinalizedEpoch >= 0
    ) {
      lastCheckpointTime = Date.now()
    }

    notifySubscribers(state as State, getAppliedOps)

    // Check if auto-compact should trigger (only when txs are added, not during auto-compact)
    if (autoCompact && !isAutoCompacting && txChanges && txChanges.added.length > 0) {
      const activeEpoch = getActiveEpochInternal()
      const txCount = clientState.stateCalculator.getTxCountForEpoch(activeEpoch)

      if (txCount > 0) {
        const params: AutoCompactParams = {
          txLog: {
            size: txCount,
            ops: clientState.stateCalculator.getOpsCountForEpoch(activeEpoch),
          },
          lastCompactionTime: lastCheckpointTime,
        }

        if (autoCompact(params)) {
          // Trigger compact (will emit a checkpoint change)
          isAutoCompacting = true
          try {
            compactInternal()
          } finally {
            isAutoCompacting = false
          }
        }
      }
    }
  }

  // Tx observer
  const txObserver = (event: SyncLogMapEvent<EncodedTxRecord>, _origin: unknown) => {
    const txChanges = extractTxChanges(event)
    runUpdate(txChanges, false)
  }

  // Checkpoint observer
  const checkpointObserver = (_event: SyncLogMapEvent<CheckpointRecord>, _origin: unknown) => {
    runUpdate(emptyTxChanges, true)
  }

  const disposeCheckpointObserver = checkpointMap.observe(checkpointObserver)
  const disposeTxObserver = txMap.observe(txObserver)

  // Initial run (full recompute, treat as checkpoint change to initialize epoch cache)
  runUpdate(undefined, true)

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

  const compactInternal = () => {
    syncLogDoc.transact(() => {
      const activeEpoch = getActiveEpochInternal()
      const currentState = clientState.stateCalculator.getCachedState() ?? {}
      createCheckpoint(txMap, checkpointMap, clientState, activeEpoch, currentState, clientId)
    }, origin)
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
      compactInternal()
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
      return clientState.stateCalculator.getTxCountForEpoch(activeEpoch)
    },

    getActiveEpochOpsCount(): number {
      assertNotDisposed()
      const activeEpoch = getActiveEpochInternal()
      return clientState.stateCalculator.getOpsCountForEpoch(activeEpoch)
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

    getLastCompactionTime(): number | undefined {
      assertNotDisposed()
      return lastCheckpointTime
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
