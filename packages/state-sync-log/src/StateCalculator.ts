import { type CheckpointRecord, type ClientWatermarks } from "./checkpoints"
import { SyncLogMap } from "./crdt/SyncLogMap"
import { applyTxImmutable } from "./draft"
import { JSONObject } from "./json"
import { Op, ValidateFn } from "./operations"
import { computeReconcileOps } from "./reconcile"
import { SortedTxEntry } from "./SortedTxEntry"
import { TxRecord } from "./TxRecord"
import { EncodedTxRecord } from "./TxRecordCompression"
import { compareTxTimestamps, type TxTimestamp, type TxTimestampKey } from "./txTimestamp"
import { lazy } from "./utils"

/**
 * Checks if a transaction is covered by the checkpoint watermarks.
 */
export function isTransactionInCheckpoint(ts: TxTimestamp, watermarks: ClientWatermarks): boolean {
  const wm = watermarks[ts.clientId]
  if (!wm) return false
  return ts.clock <= wm.maxClock
}

/**
 * StateCalculator encapsulates the sorted transaction cache and state calculation logic.
 *
 * It maintains:
 * - A sorted array of transaction entries
 * - A map for O(1) lookup
 * - A tracking index indicating up to which tx the state has been calculated
 * - The cached calculated state
 * - The base checkpoint
 *
 * The tracking index is invalidated (set to null) when:
 * - A transaction is inserted before the already-calculated slice
 * - A transaction is deleted from the already-calculated slice
 * - The base checkpoint changes
 */
export class StateCalculator {
  /** Sorted tx cache (ALL active/future txs, kept sorted by timestamp) */
  private sortedTxs: SortedTxEntry[] = []

  /** O(1) existence check and lookup */
  private sortedTxsMap: Map<TxTimestampKey, SortedTxEntry> = new Map()

  /**
   * Index of the last transaction applied to cachedState.
   * - null: state needs full recalculation from checkpoint
   * - -1: no transactions have been applied yet (state === checkpoint state)
   * - >= 0: transactions up to and including this index have been applied
   */
  private lastAppliedIndex: number | null = null

  /** The cached calculated state */
  private cachedState: JSONObject | null = null

  /** The base checkpoint to calculate state from */
  private baseCheckpoint: CheckpointRecord | null = null

  /**
   * Applied dedup keys - tracks which LOGICAL txs have been applied.
   * This is the originalTxKey (or physical key if no original) for each applied tx.
   * Used to properly deduplicate re-emits.
   */
  private appliedTxKeys: Set<TxTimestampKey> = new Set()

  /** Max clock seen from any transaction (for Lamport clock updates) */
  private maxSeenClock = 0

  /** Validation function (optional) */
  private validateFn?: ValidateFn<JSONObject>

  /** Ops count per epoch (incremented on insert, decremented on remove) */
  private opsCountByEpoch: Map<number, number> = new Map()

  /** Tx count per epoch (incremented on insert, decremented on remove) */
  private txCountByEpoch: Map<number, number> = new Map()

  constructor(validateFn?: ValidateFn<JSONObject>) {
    this.validateFn = validateFn
  }

  /**
   * Sets the base checkpoint. Invalidates cached state if checkpoint changed.
   * @returns true if the checkpoint changed
   */
  setBaseCheckpoint(checkpoint: CheckpointRecord | null): boolean {
    if (checkpoint === this.baseCheckpoint) {
      return false
    }

    this.baseCheckpoint = checkpoint
    this.invalidate()
    return true
  }

  /**
   * Gets the current base checkpoint.
   */
  getBaseCheckpoint(): CheckpointRecord | null {
    return this.baseCheckpoint
  }

  /**
   * Clears all transactions and rebuilds from the tx map.
   * This is used when the checkpoint changes and we need a fresh start.
   */
  rebuildFromSyncLogMap(txMap: SyncLogMap<EncodedTxRecord>): void {
    this.sortedTxs = []
    this.sortedTxsMap.clear()
    this.opsCountByEpoch.clear()
    this.txCountByEpoch.clear()

    // Collect all entries, build the map and max clock
    for (const key of txMap.keys()) {
      const entry = new SortedTxEntry(key, txMap)
      this.sortedTxs.push(entry)

      this.sortedTxsMap.set(entry.txTimestampKey, entry)
      if (entry.txTimestamp.clock > this.maxSeenClock) {
        this.maxSeenClock = entry.txTimestamp.clock
      }

      // Update per-epoch counts
      const epoch = entry.txTimestamp.epoch
      const opsCount = entry.txRecord.ops.length
      this.opsCountByEpoch.set(epoch, (this.opsCountByEpoch.get(epoch) ?? 0) + opsCount)
      this.txCountByEpoch.set(epoch, (this.txCountByEpoch.get(epoch) ?? 0) + 1)
    }

    // Sort once - O(n log n)
    this.sortedTxs.sort((a, b) => compareTxTimestamps(a.txTimestamp, b.txTimestamp))

    // Invalidate cached state since we rebuilt
    this.invalidate()
  }

  /**
   * Inserts a transaction into the sorted cache.
   * Invalidates cached state if the transaction was inserted before the calculated slice.
   *
   * @returns true if this caused invalidation (out-of-order insert)
   */
  insertTx(key: TxTimestampKey, txMap: SyncLogMap<EncodedTxRecord>): boolean {
    if (this.sortedTxsMap.has(key)) {
      return false // Already exists
    }

    const entry = new SortedTxEntry(key, txMap)
    const ts = entry.txTimestamp

    // Update max seen clock for Lamport clock mechanism
    if (ts.clock > this.maxSeenClock) {
      this.maxSeenClock = ts.clock
    }

    // Update per-epoch counts
    const epoch = ts.epoch
    const opsCount = entry.txRecord.ops.length
    this.opsCountByEpoch.set(epoch, (this.opsCountByEpoch.get(epoch) ?? 0) + opsCount)
    this.txCountByEpoch.set(epoch, (this.txCountByEpoch.get(epoch) ?? 0) + 1)

    const sortedTxs = this.sortedTxs

    // Find insertion position (search from end since new txs typically have higher timestamps)
    let insertIndex = sortedTxs.length // Default: append at end
    for (let i = sortedTxs.length - 1; i >= 0; i--) {
      const existingTs = sortedTxs[i].txTimestamp
      if (compareTxTimestamps(ts, existingTs) >= 0) {
        insertIndex = i + 1
        break
      }
      if (i === 0) {
        insertIndex = 0 // Insert at beginning
      }
    }

    // Insert at the found position
    sortedTxs.splice(insertIndex, 0, entry)
    this.sortedTxsMap.set(key, entry)

    // Check if this invalidates our cached state
    // If we inserted before or at the last applied index, we need to recalculate
    if (this.lastAppliedIndex !== null && insertIndex <= this.lastAppliedIndex) {
      this.invalidate()
      return true
    }

    return false
  }

  /**
   * Removes multiple transactions from the sorted cache.
   * @returns the number of keys that were actually removed
   */
  removeTxs(keys: readonly TxTimestampKey[]): number {
    if (keys.length === 0) return 0

    let removedCount = 0
    let minRemovedIndex = Number.POSITIVE_INFINITY

    // Build set of keys to delete and track their indices
    const toDelete = new Set<TxTimestampKey>()
    for (const key of keys) {
      const entry = this.sortedTxsMap.get(key)
      if (entry) {
        // Decrement per-epoch counts before removing
        const epoch = entry.txTimestamp.epoch
        const opsCount = entry.txRecord.ops.length

        const currentOps = this.opsCountByEpoch.get(epoch) ?? 0
        const newOps = currentOps - opsCount
        if (newOps <= 0) {
          this.opsCountByEpoch.delete(epoch)
        } else {
          this.opsCountByEpoch.set(epoch, newOps)
        }

        const currentTxs = this.txCountByEpoch.get(epoch) ?? 0
        const newTxs = currentTxs - 1
        if (newTxs <= 0) {
          this.txCountByEpoch.delete(epoch)
        } else {
          this.txCountByEpoch.set(epoch, newTxs)
        }

        this.sortedTxsMap.delete(key)
        toDelete.add(key)

        // Find index for invalidation check
        const index = this.sortedTxs.indexOf(entry)
        if (index !== -1 && index < minRemovedIndex) {
          minRemovedIndex = index
        }
      }
    }

    if (toDelete.size === 0) return 0

    // Single forward pass through sortedTxs, removing matching entries
    const sortedTxs = this.sortedTxs
    let i = 0
    while (i < sortedTxs.length && toDelete.size > 0) {
      if (toDelete.has(sortedTxs[i].txTimestampKey)) {
        toDelete.delete(sortedTxs[i].txTimestampKey)
        sortedTxs.splice(i, 1)
        removedCount++
      } else {
        i++
      }
    }

    // Check if this invalidates our cached state
    if (this.lastAppliedIndex !== null && minRemovedIndex <= this.lastAppliedIndex) {
      this.invalidate()
    }

    return removedCount
  }

  /**
   * Checks if a transaction key exists in the cache.
   */
  hasTx(key: TxTimestampKey): boolean {
    return this.sortedTxsMap.has(key)
  }

  /**
   * Gets a transaction entry by key.
   */
  getTx(key: TxTimestampKey): SortedTxEntry | undefined {
    return this.sortedTxsMap.get(key)
  }

  /**
   * Gets all sorted transaction entries.
   */
  getSortedTxs(): readonly SortedTxEntry[] {
    return this.sortedTxs
  }

  /**
   * Gets the number of transactions in the cache.
   */
  get txCount(): number {
    return this.sortedTxs.length
  }

  /**
   * Gets the number of operations for a specific epoch.
   */
  getOpsCountForEpoch(epoch: number): number {
    return this.opsCountByEpoch.get(epoch) ?? 0
  }

  /**
   * Gets the number of transactions for a specific epoch.
   */
  getTxCountForEpoch(epoch: number): number {
    return this.txCountByEpoch.get(epoch) ?? 0
  }

  /**
   * Returns true if the state needs full recalculation.
   */
  needsFullRecalculation(): boolean {
    return this.lastAppliedIndex === null
  }

  /**
   * Invalidates the cached state, forcing a full recalculation on next calculateState().
   * Note: cachedState is kept so computeReconcileOps can diff old vs new state.
   */
  invalidate(): void {
    this.lastAppliedIndex = null
  }

  /**
   * Calculates and returns the current state, along with a lazy getter for ops that changed from the previous state.
   *
   * - If lastAppliedIndex is null: full recalculation from checkpoint
   * - If lastAppliedIndex >= -1: incremental apply from lastAppliedIndex + 1
   */
  calculateState(): { state: JSONObject; getAppliedOps: () => readonly Op[] } {
    const baseState: JSONObject = this.baseCheckpoint?.state ?? {}
    const watermarks = this.baseCheckpoint?.watermarks ?? {}
    const hasWatermarks = Object.keys(watermarks).length > 0

    if (this.lastAppliedIndex === null) {
      // SLOW PATH: Full recalculation
      return this.fullRecalculation(baseState, watermarks, hasWatermarks)
    }

    // FAST PATH: Incremental apply
    return this.incrementalApply(watermarks, hasWatermarks)
  }

  /**
   * Full recalculation of state from the base checkpoint.
   */
  private fullRecalculation(
    baseState: JSONObject,
    watermarks: ClientWatermarks,
    hasWatermarks: boolean
  ): { state: JSONObject; getAppliedOps: () => readonly Op[] } {
    const oldState = this.cachedState ?? {}

    // Reset tracking for full recompute
    this.appliedTxKeys.clear()
    this.lastAppliedIndex = -1
    this.cachedState = baseState

    // Delegate to incremental apply to replay all transactions
    // We ignore the returned ops because they represent the operations applied from the base state,
    // whereas we want the diff from the *previous cached state*.
    // We pass returnOps=false to avoid collecting ops during replay.
    const { state } = this.incrementalApply(watermarks, hasWatermarks, false)

    // Lazy load the reconciliation ops (expensive diff)
    const getAppliedOps = lazy(() => computeReconcileOps(oldState, state))

    return { state, getAppliedOps }
  }

  /**
   * Incremental apply of transactions from lastAppliedIndex + 1.
   * @param returnOps If true, collects applied transactions (to lazy compute ops). If false, skips collection.
   */
  private incrementalApply(
    watermarks: ClientWatermarks,
    hasWatermarks: boolean,
    returnOps = true
  ): { state: JSONObject; getAppliedOps: () => readonly Op[] } {
    let state = this.cachedState as JSONObject
    const appliedTxs: TxRecord[] = []
    const sortedTxs = this.sortedTxs
    const startIndex = this.lastAppliedIndex! + 1

    for (let i = startIndex; i < sortedTxs.length; i++) {
      const entry = sortedTxs[i]
      const dedupKey = entry.dedupTxTimestampKey

      // Skip if already applied (deduplication)
      if (this.appliedTxKeys.has(dedupKey)) {
        continue
      }

      // Skip if in checkpoint
      if (hasWatermarks) {
        const dedupTs = entry.dedupTxTimestamp
        if (isTransactionInCheckpoint(dedupTs, watermarks)) {
          this.appliedTxKeys.add(dedupKey)
          continue
        }
      }

      const tx = entry.txRecord

      // Apply transaction 1-by-1 to avoid draft context pollution on validation failure
      const newState = applyTxImmutable(state, tx, this.validateFn)

      if (newState !== state) {
        state = newState
        if (returnOps) {
          appliedTxs.push(tx)
        }
      }

      this.appliedTxKeys.add(dedupKey)
      this.lastAppliedIndex = i
    }

    // Update lastAppliedIndex to end even if all txs were skipped
    // This ensures we don't re-process skipped txs on next incremental apply
    if (sortedTxs.length > 0 && this.lastAppliedIndex! < sortedTxs.length - 1) {
      this.lastAppliedIndex = sortedTxs.length - 1
    }

    this.cachedState = state

    // Lazy getter for ops (flattens applied txs)
    const getAppliedOps = lazy(() => {
      const ops: Op[] = []
      for (const tx of appliedTxs) {
        ops.push(...tx.ops)
      }
      return ops
    })

    return { state, getAppliedOps }
  }

  /**
   * Gets the max seen clock (for Lamport clock updates).
   */
  getMaxSeenClock(): number {
    return this.maxSeenClock
  }

  /**
   * Gets the current cached state without recalculating.
   * Returns null if state has never been calculated.
   */
  getCachedState(): JSONObject | null {
    return this.cachedState
  }

  /**
   * Gets the last applied timestamp.
   */
  getLastAppliedTs(): TxTimestamp | null {
    if (this.lastAppliedIndex === null || this.lastAppliedIndex < 0) {
      return null
    }
    return this.sortedTxs[this.lastAppliedIndex]?.txTimestamp ?? null
  }

  /**
   * Gets the last applied index (for debugging/tracking).
   */
  getLastAppliedIndex(): number | null {
    return this.lastAppliedIndex
  }
}
