import { failure } from "./error"

/**
 * Parsed tx timestamp components.
 */
export type TxTimestamp = {
  epoch: number
  clock: number
  clientId: string
  wallClock: number
}

/**
 * Unique tx ID (Composite Key).
 */
export type TxTimestampKey = string

/**
 * Converts a timestamp object to a TransactionTimestampKey string.
 */
export function txTimestampToKey(ts: TxTimestamp): TxTimestampKey {
  return `${ts.clientId};${ts.clock};;${ts.epoch};${ts.wallClock}`
}

/**
 * Helper to parse tx timestamp keys.
 * Throws if key is malformed.
 */
export function parseTxTimestampKey(key: TxTimestampKey): TxTimestamp {
  const parts = key.split(";")
  if (parts.length < 5 || parts[2] !== "") {
    failure(`Malformed timestamp key: ${key}`)
  }

  return {
    clientId: parts[0],
    clock: Number.parseInt(parts[1], 10),
    epoch: Number.parseInt(parts[3], 10),
    wallClock: Number.parseInt(parts[4], 10),
  }
}

/**
 * Compares two tx timestamps for deterministic ordering.
 * Sort order: epoch (asc) → clock (asc) → clientId (asc)
 */
export function compareTxTimestamps(a: TxTimestamp, b: TxTimestamp): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch
  if (a.clock !== b.clock) return a.clock - b.clock
  if (a.clientId < b.clientId) return -1
  if (a.clientId > b.clientId) return 1
  return 0
}
