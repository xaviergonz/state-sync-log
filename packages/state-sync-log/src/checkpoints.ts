import { ClientId } from "./ClientId"
import { getFinalizedEpochAndCheckpoint } from "./checkpointUtils"
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
function checkpointKeyDataToKey(data: CheckpointKeyData): CheckpointKey {
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
 * Called periodically (e.g. by a server or leader client) to finalize the epoch.
 */
export function createCheckpoint(
  txMap: SyncLogMap<EncodedTxRecord>,
  checkpointMap: SyncLogMap<CheckpointRecord>,
  clientState: ClientState,
  activeEpoch: number,
  currentState: JSONObject,
  myClientId: string
): void {
  // 1. Start with previous watermarks (from finalized epoch = activeEpoch - 1)
  const { checkpoint: prevCP } = getFinalizedEpochAndCheckpoint(checkpointMap)
  const newWatermarks = prevCP ? { ...prevCP.watermarks } : {}

  // Get active txs using cached sorted order (filter by epoch)
  // FILTER IS REQUIRED:
  // Although we are finalizing 'activeEpoch', other peers may have already
  // advanced to the next epoch and started syncing those txs.
  // We must ensure this checkpoint ONLY contains txs from 'activeEpoch'.
  // Using stateCalculator.getSortedTxs avoids redundant key parsing (timestamps are cached).
  //
  // OPTIMIZATION: Since sortedTxs is sorted by epoch (primary key) and past epochs
  // are pruned, we only need to find the right boundary. Future epochs are rare,
  // so a simple linear search from the right is efficient (typically 0-1 iterations).
  const sortedTxs = clientState.stateCalculator.getSortedTxs()

  // Find end boundary by searching from right (skip any future epoch entries)
  let endIndex = sortedTxs.length
  while (endIndex > 0 && sortedTxs[endIndex - 1].txTimestamp.epoch > activeEpoch) {
    endIndex--
  }

  // Slice from start to endIndex (past epochs are pruned, so these are all activeEpoch)
  const activeTxs = sortedTxs.slice(0, endIndex)

  if (activeTxs.length === 0) {
    return // Do nothing if no txs (prevents empty epochs)
  }

  // 2. Update watermarks based on OBSERVED active txs and calculate minWallClock
  // NOTE: We cannot use activeTxs[0].txTimestamp.wallClock for minWallClock because
  // txs are sorted by Lamport clock (epoch → clock → clientId), not by wallClock.
  // A client may have a high Lamport clock but early wallClock due to clock drift
  // or receiving many messages before emitting.
  let minWallClock = Number.POSITIVE_INFINITY
  let txCount = 0
  for (const entry of activeTxs) {
    const ts = entry.txTimestamp

    // Track min wallClock for deterministic pruning reference
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

  // 3. Prune Inactive Watermarks (Deterministic)
  // Uses minWallClock so all clients agree on exactly who to prune.
  for (const clientId in newWatermarks) {
    if (minWallClock - newWatermarks[clientId].maxWallClock > clientState.retentionWindowMs) {
      delete newWatermarks[clientId]
    }
  }

  // 4. Save Checkpoint
  const cpKey = checkpointKeyDataToKey({
    epoch: activeEpoch,
    txCount,
    clientId: myClientId,
  })
  checkpointMap.set(cpKey, {
    state: currentState, // Responsibility for cloning is moved to the caller if needed
    watermarks: newWatermarks,
    txCount,
    minWallClock,
  })

  // 5. Early tx pruning (Optimization)
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
