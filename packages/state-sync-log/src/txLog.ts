import { type CheckpointRecord, pruneCheckpoints } from "./checkpoints"
import { getFinalizedEpochAndCheckpoint } from "./checkpointUtils"
import { ClientState } from "./clientState"
import { SyncLogDoc } from "./crdt/SyncLogDoc"
import { SyncLogMap } from "./crdt/SyncLogMap"
import { JSONObject } from "./json"
import { Op } from "./operations"
import { SortedTxEntry } from "./SortedTxEntry"
import { isTransactionInCheckpoint } from "./StateCalculator"
import { TxRecord } from "./TxRecord"
import { type TxTimestamp, type TxTimestampKey, txTimestampToKey } from "./txTimestamp"

/**
 * Changes to transaction keys from a map event.
 * - added: keys that were added
 * - deleted: keys that were deleted
 */
export type TxKeyChanges = {
  added: readonly TxTimestampKey[]
  deleted: readonly TxTimestampKey[]
}

/**
 * Appends a new transaction to the log.
 *
 * @param originalKey - Optional reference to the original transaction key for re-emits.
 *                      Used by syncLog to preserve transactions missed by checkpoints.
 */
export function appendTx(
  ops: readonly Op[],
  txMap: SyncLogMap<TxRecord>,
  activeEpoch: number,
  myClientId: string,
  clientState: ClientState,
  originalKey?: TxTimestampKey
): TxTimestampKey {
  const calc = clientState.stateCalculator

  // 1. Advance logical clock (Lamport) based on all seen traffic
  const clock = Math.max(clientState.localClock, calc.getMaxSeenClock()) + 1
  clientState.localClock = clock

  // 2. Generate Key with WallClock for future pruning safety
  const ts: TxTimestamp = {
    epoch: activeEpoch,
    clock,
    clientId: myClientId,
    wallClock: Date.now(),
  }
  const key = txTimestampToKey(ts)

  // 3. Write to SyncLogMap (Atomic)
  const record: TxRecord = { ops, originalTxKey: originalKey }
  txMap.set(key, record)

  return key
}

/**
 * Synchronizes the transaction log with the current checkpoint.
 * Re-emits missed transactions and prunes old ones.
 *
 * Should be called BEFORE updateState to ensure log is clean and complete.
 *
 * @returns true if any transactions were re-emitted or deleted, which may invalidate lastAppliedIndex
 */
function syncLog(
  txMap: SyncLogMap<TxRecord>,
  myClientId: string,
  clientState: ClientState,
  finalizedEpoch: number,
  baseCP: CheckpointRecord | null,
  newKeys?: readonly TxTimestampKey[] // keys added in this update
): void {
  const calc = clientState.stateCalculator
  const activeEpoch = finalizedEpoch + 1
  const watermarks = baseCP?.watermarks ?? {}

  // Deterministic Reference Time: Use stored minWallClock if available, otherwise 0 (nothing ancient).
  const referenceTime = baseCP?.minWallClock ?? 0

  // Helper to check if a transaction should be pruned
  const shouldPrune = (ts: TxTimestamp, dedupTs: TxTimestamp): boolean => {
    const isAncient = referenceTime - ts.wallClock > clientState.retentionWindowMs
    if (isAncient) return true
    return isTransactionInCheckpoint(dedupTs, watermarks)
  }

  const toDelete: TxTimestampKey[] = []
  const toReEmit: Array<{ originalKey: TxTimestampKey; tx: TxRecord }> = []

  // 1. Helper to decide what to do with each transaction
  const processEntry = (entry: SortedTxEntry): boolean => {
    if (shouldPrune(entry.txTimestamp, entry.dedupTxTimestamp)) {
      toDelete.push(entry.txTimestampKey)
      return false // deleted
    }

    if (entry.txTimestamp.epoch <= finalizedEpoch) {
      // Not in checkpoint and still fresh - re-emit it to the active epoch
      toReEmit.push({ originalKey: entry.dedupTxTimestampKey, tx: entry.txRecord })
      toDelete.push(entry.txTimestampKey)
      return false // re-emitted
    }

    return true // active/fresh
  }

  // 2. Scan local cache (sortedTxs) to identify missing/ancient transactions
  for (const entry of calc.getSortedTxs()) {
    if (processEntry(entry)) {
      // Optimization: Physical keys are sorted. If we hit the active/fresh territory, we can stop.
      break
    }
  }

  const processKeyByTimestampKey = (txTimestampKey: TxTimestampKey): void => {
    // Only process if it actually exists in the map
    if (txMap.has(txTimestampKey)) {
      processEntry(new SortedTxEntry(txTimestampKey, txMap))
    }
  }

  // 3. Scan NEW keys to handle incoming transactions (sync)
  // Any client can re-emit - deduplication via originalTxKey handles duplicates.
  if (newKeys) {
    for (const key of newKeys) {
      processKeyByTimestampKey(key)
    }
  }

  // 4. Re-emit missed transactions BEFORE pruning
  for (const { originalKey, tx } of toReEmit) {
    const newKey = appendTx(tx.ops, txMap, activeEpoch, myClientId, clientState, originalKey)
    calc.insertTx(newKey, txMap)
  }

  // 5. Prune old/finalized/redundant transactions from map
  for (const key of toDelete) {
    txMap.delete(key)
  }
  calc.removeTxs(toDelete)
}

/**
 * The primary update function that maintains current state.
 *
 * @param txChanges - Changes from map event. If undefined (first run), performs a full scan.
 */
export function updateState(
  doc: SyncLogDoc,
  txMap: SyncLogMap<TxRecord>,
  checkpointMap: SyncLogMap<CheckpointRecord>,
  myClientId: string,
  clientState: ClientState,
  txChanges: TxKeyChanges | undefined
): { state: JSONObject; getAppliedOps: () => readonly Op[] } {
  const calc = clientState.stateCalculator

  // Always calculate fresh finalized epoch and checkpoint to handle sync race conditions
  const { finalizedEpoch, checkpoint: baseCP } = getFinalizedEpochAndCheckpoint(checkpointMap)

  // Update read-cache
  clientState.cachedFinalizedEpoch = finalizedEpoch

  // Set base checkpoint (this handles invalidation if checkpoint changed)
  calc.setBaseCheckpoint(baseCP)

  // Track if we need to rebuild sorted cache (first run or missing delta)
  // Optimization: We don't need to rebuild just because checkpoint changed,
  // as long as we have txChanges to keep cache in sync.
  const needsRebuildSortedCache = calc.getCachedState() === null || !txChanges

  // Rebuild sorted cache before syncLog if needed
  if (needsRebuildSortedCache) {
    calc.rebuildFromSyncLogMap(txMap)
  } else {
    // If not rebuilding, immediately process deletions to avoid "ghost" transactions
    // in syncLog (e.g. attempting to access a transaction that was just deleted).
    calc.removeTxs(txChanges.deleted)
  }

  // Sync and prune within transaction
  doc.transact(() => {
    syncLog(txMap, myClientId, clientState, finalizedEpoch, baseCP, txChanges?.added)

    // Safe to use local finalizedEpoch here
    pruneCheckpoints(checkpointMap, finalizedEpoch)
  })

  if (needsRebuildSortedCache) {
    // Full recompute (calculator handles this)
    return calc.calculateState()
  }

  // Incremental update using only changed keys (calculator handles this)
  // txChanges is guaranteed to exist here since !txChanges implies needsRebuildSortedCache

  // Update sorted cache with new keys from txChanges
  // This must happen after syncLog which may have deleted some of these keys
  for (const key of txChanges.added) {
    // CRITICAL: Check txMap.has(key)! syncLog might have just pruned it.
    if (txMap.has(key) && !calc.hasTx(key)) {
      calc.insertTx(key, txMap)
    }
  }

  return calc.calculateState()
}
