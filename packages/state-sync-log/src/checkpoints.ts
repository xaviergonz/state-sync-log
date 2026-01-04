import { ClientId } from "./ClientId"
import { ClientState } from "./clientState"
import { SyncLogMap } from "./crdt/SyncLogMap"
import { failure } from "./error"
import { JSONObject } from "./json"
import { EncodedTxRecord } from "./TxRecordCompression"
import { TxTimestampKey } from "./txTimestamp"

/**
 * Watermarking for deduplication and pruning.
 * - maxClock: All txs from this client with clock <= maxClock are FINALIZED.
 * - maxWallClock: The last time we saw this client active (for pruning).
 */
type ClientWatermark = Readonly<{
  maxClock: number
  maxWallClock: number
}>

/**
 * Watermarks for all clients.
 */
export type ClientWatermarks = Record<ClientId, ClientWatermark>

/**
 * A snapshot of the state at the end of a specific epoch.
 */
export type CheckpointRecord = {
  state: JSONObject // The document state
  watermarks: ClientWatermarks // Dedup/Pruning info
  txCount: number // Tie-breaker for canonical selection
  minWallClock: number // Reference time for this epoch (deterministic pruning)
}

/**
 * Unique ID for a checkpoint.
 * Format: `${epoch};${txCount};${clientId}`
 */
export type CheckpointKey = string

/**
 * Data extracted from a checkpoint key.
 */
export type CheckpointKeyData = {
  epoch: number
  txCount: number
  clientId: ClientId
}

/**
 * Converts checkpoint key data components to a key string.
 */
export function checkpointKeyDataToKey(data: CheckpointKeyData): CheckpointKey {
  return `${data.clientId};${data.epoch};;${data.txCount}`
}

/**
 * Helper to parse checkpoint keys.
 * Checkpoint keys have format: `${clientId};${epoch};;${txCount}`
 * Throws if key is malformed.
 */
export function parseCheckpointKey(key: CheckpointKey): CheckpointKeyData {
  const parts = key.split(";")

  if (parts.length < 4 || parts[2] !== "") {
    failure(`Malformed checkpoint key: ${key}`)
  }

  return {
    clientId: parts[0],
    epoch: Number.parseInt(parts[1], 10),
    txCount: Number.parseInt(parts[3], 10),
  }
}

/**
 * Data returned by createCheckpoint for server-mediated checkpointing.
 * The server should broadcast this to all connected clients via addCheckpoint.
 */
export interface CheckpointData {
  /**
   * The unique key for this checkpoint.
   */
  key: CheckpointKey
  /**
   * The checkpoint record containing state snapshot and metadata.
   */
  record: CheckpointRecord
}

/**
 * Helper to get active txs for the current epoch from sorted txs.
 */
function getActiveTxsForEpoch(
  clientState: ClientState,
  activeEpoch: number
): readonly import("./SortedTxEntry").SortedTxEntry[] {
  const sortedTxs = clientState.stateCalculator.getSortedTxs()

  // Find end boundary by searching from right (skip any future epoch entries)
  let endIndex = sortedTxs.length
  while (endIndex > 0 && sortedTxs[endIndex - 1].txTimestamp.epoch > activeEpoch) {
    endIndex--
  }

  // Slice from start to endIndex (past epochs are pruned, so these are all activeEpoch)
  return sortedTxs.slice(0, endIndex)
}

/**
 * Builds checkpoint data without persisting it.
 * Returns null if there are no transactions to checkpoint.
 */
export function buildCheckpointData(
  clientState: ClientState,
  activeEpoch: number,
  currentState: JSONObject,
  clientId: string,
  prevCheckpoint: CheckpointRecord | null
): CheckpointData | null {
  const newWatermarks = prevCheckpoint ? { ...prevCheckpoint.watermarks } : {}

  // Get active txs for current epoch
  const activeTxs = getActiveTxsForEpoch(clientState, activeEpoch)

  if (activeTxs.length === 0) {
    return null // No txs to checkpoint
  }

  // Calculate watermarks and minWallClock
  let minWallClock = Number.POSITIVE_INFINITY
  let txCount = 0
  for (const entry of activeTxs) {
    const ts = entry.txTimestamp

    if (ts.wallClock < minWallClock) {
      minWallClock = ts.wallClock
    }

    const newWm = newWatermarks[ts.clientId]
      ? { ...newWatermarks[ts.clientId] }
      : { maxClock: -1, maxWallClock: 0 }

    if (ts.clock > newWm.maxClock) {
      newWm.maxClock = ts.clock
      newWm.maxWallClock = ts.wallClock
    }
    newWatermarks[ts.clientId] = newWm
    txCount++
  }

  // Prune inactive watermarks
  for (const wClientId in newWatermarks) {
    if (minWallClock - newWatermarks[wClientId].maxWallClock > clientState.retentionWindowMs) {
      delete newWatermarks[wClientId]
    }
  }

  // Build checkpoint key and record
  const cpKey = checkpointKeyDataToKey({
    epoch: activeEpoch,
    txCount,
    clientId,
  })

  const cpRecord: CheckpointRecord = {
    state: currentState,
    watermarks: newWatermarks,
    txCount,
    minWallClock,
  }

  return { key: cpKey, record: cpRecord }
}

/**
 * Internal function called to persist a checkpoint and prune transactions.
 * Called by addCheckpoint in createStateSyncLog.
 *
 * @param checkpoint - The checkpoint data to persist (created by createCheckpoint)
 */
export function createCheckpointInternal(
  txMap: SyncLogMap<EncodedTxRecord>,
  checkpointMap: SyncLogMap<CheckpointRecord>,
  clientState: ClientState,
  activeEpoch: number,
  _currentState: JSONObject,
  _myClientId: string,
  checkpoint: CheckpointData
): void {
  // 1. Persist the checkpoint
  checkpointMap.set(checkpoint.key, checkpoint.record)

  // 2. Get active txs for pruning
  const activeTxs = getActiveTxsForEpoch(clientState, activeEpoch)

  // 3. Early tx pruning (Optimization)
  // Delete all txs from the now-finalized epoch
  // This reduces memory pressure instead of waiting for cleanupLog
  const keysToDelete: TxTimestampKey[] = []
  for (const entry of activeTxs) {
    txMap.delete(entry.txTimestampKey)
    keysToDelete.push(entry.txTimestampKey)
  }
  clientState.stateCalculator.removeTxs(keysToDelete)
}

/**
 * Garbage collects old checkpoints.
 * Should be called periodically to prevent unbounded growth of checkpointMap.
 *
 * Keeps only the canonical checkpoint for the finalized epoch.
 * Everything else is deleted (old epochs + non-canonical).
 *
 * Note: The active epoch never has checkpoints - creating a checkpoint
 * for an epoch immediately makes it finalized.
 */
export function pruneCheckpoints(
  checkpointMap: SyncLogMap<CheckpointRecord>,
  finalizedEpoch: number
): void {
  // Find the canonical checkpoint and its key in one pass
  let canonicalKey: CheckpointKey | null = null
  let bestTxCount = -1
  let bestClientId = ""

  for (const [key] of checkpointMap.entries()) {
    const { epoch, txCount, clientId } = parseCheckpointKey(key)
    if (epoch === finalizedEpoch) {
      if (
        canonicalKey === null ||
        txCount > bestTxCount ||
        (txCount === bestTxCount && clientId < bestClientId)
      ) {
        canonicalKey = key
        bestTxCount = txCount
        bestClientId = clientId
      }
    }
  }

  // Delete everything except the canonical checkpoint
  for (const key of checkpointMap.keys()) {
    if (key !== canonicalKey) {
      checkpointMap.delete(key)
    }
  }
}
