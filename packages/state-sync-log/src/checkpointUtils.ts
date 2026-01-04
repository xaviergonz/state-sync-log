import { type CheckpointRecord, parseCheckpointKey } from "./checkpoints"
import { SyncLogMap } from "./crdt/SyncLogMap"

/**
 * Determines the finalized epoch and its canonical checkpoint in a single pass.
 *
 * Policy A: The finalized epoch is the most recent epoch with a checkpoint.
 * Canonical checkpoint: The checkpoint with highest txCount for that epoch
 * (tie-break: lowest clientId alphabetically).
 *
 * Returns { finalizedEpoch: -1, checkpoint: null } if no checkpoints exist.
 */
export function getFinalizedEpochAndCheckpoint(checkpointMap: SyncLogMap<CheckpointRecord>): {
  finalizedEpoch: number
  checkpoint: CheckpointRecord | null
} {
  let maxEpoch = -1
  let best: CheckpointRecord | null = null
  let bestTxCount = -1
  let bestClientId = ""

  for (const [key, cp] of checkpointMap.entries()) {
    const { epoch, clientId } = parseCheckpointKey(key)

    if (epoch > maxEpoch) {
      // New highest epoch - reset best checkpoint tracking
      maxEpoch = epoch
      best = cp
      bestTxCount = cp.txCount
      bestClientId = clientId
    } else if (epoch === maxEpoch) {
      // Same epoch - check if this is a better canonical checkpoint
      // Primary: higher txCount wins
      // Secondary (tie-break): lower clientId (alphabetically) wins
      if (cp.txCount > bestTxCount || (cp.txCount === bestTxCount && clientId < bestClientId)) {
        best = cp
        bestTxCount = cp.txCount
        bestClientId = clientId
      }
    }
  }

  return { finalizedEpoch: maxEpoch, checkpoint: best }
}
