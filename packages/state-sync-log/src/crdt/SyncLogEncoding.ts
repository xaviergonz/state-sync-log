import { failure } from "../error"
import { JSONValue } from "../json"

/**
 * Key format: CLIENTID;integer;;whatever
 * - CLIENTID: any string (caller validates no semicolons)
 * - integer: monotonic sequence number
 * - ;;: separator between rangeable and metadata
 * - whatever: arbitrary metadata (may contain semicolons)
 */
/**
 * Parses and validates a key.
 * Throws if the key doesn't match the expected format.
 */
export function parseKey(key: string): { clientId: string; seq: number; meta: string } {
  const fail = () => {
    failure(`Invalid key format: "${key}". Expected: CLIENTID;integer;;metadata`)
  }

  // Manual parsing is ~30% faster than RegExp for this format
  const i1 = key.indexOf(";")
  if (i1 === -1 || i1 === 0) fail()

  const i2 = key.indexOf(";", i1 + 1)
  if (i2 === -1) fail()

  // Check for ;; separator (second semicolon at i2, third must be at i2+1)
  if (key.charCodeAt(i2 + 1) !== 59) fail() // 59 is ';'

  const seqLen = i2 - i1 - 1
  if (seqLen <= 0) fail()

  const seqStr = key.slice(i1 + 1, i2)

  // Fast digit validation
  for (let i = 0; i < seqLen; i++) {
    const code = seqStr.charCodeAt(i)
    if (code < 48 || code > 57) fail()
  }

  return {
    clientId: key.slice(0, i1),
    seq: Number.parseInt(seqStr, 10),
    meta: key.slice(i2 + 2),
  }
}

/**
 * State vector: maps clientId to max seen sequence number.
 */
export type StateVector = Map<string, number>

/**
 * Active entry in the map.
 */
export interface ActiveEntry {
  key: string
  value: JSONValue
  clientId: string
  seq: number
}

/**
 * Tombstone range for a client.
 * Represents deleted sequence numbers [start, end] (inclusive).
 */
export interface TombstoneRange {
  start: number
  end: number
}

/**
 * Map store structure.
 */
export interface MapStore {
  active: Map<string, ActiveEntry>
  // clientId -> sorted array of ranges
  tombstones: Map<string, TombstoneRange[]>
}

/**
 * Encodes ranges using delta encoding.
 * Input: [[1, 10], [15, 20]] -> [1, 9, 15, 5] (start, length-1, start, length-1)
 */
function encodeRanges(ranges: TombstoneRange[]): number[] {
  const result: number[] = []
  for (const range of ranges) {
    result.push(range.start, range.end - range.start)
  }
  return result
}

/**
 * Decodes ranges from delta encoding.
 */
function decodeRanges(encoded: number[]): TombstoneRange[] {
  const ranges: TombstoneRange[] = []
  for (let i = 0; i < encoded.length; i += 2) {
    const start = encoded[i]
    const length = encoded[i + 1]
    ranges.push({ start, end: start + length })
  }
  return ranges
}

/**
 * Adds a sequence number to tombstone ranges, merging adjacent ranges.
 */
export function addToTombstones(
  tombstones: Map<string, TombstoneRange[]>,
  clientId: string,
  seq: number
): void {
  let ranges = tombstones.get(clientId)
  if (!ranges) {
    ranges = []
    tombstones.set(clientId, ranges)
  }

  // Find insertion point
  let insertIdx = 0
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]
    if (seq >= range.start && seq <= range.end) {
      // Already in a range
      return
    }
    if (seq === range.start - 1) {
      // Extend range backward
      range.start = seq
      // Check if we can merge with previous
      if (i > 0 && ranges[i - 1].end === seq - 1) {
        ranges[i - 1].end = range.end
        ranges.splice(i, 1)
      }
      return
    }
    if (seq === range.end + 1) {
      // Extend range forward
      range.end = seq
      // Check if we can merge with next
      if (i < ranges.length - 1 && ranges[i + 1].start === seq + 1) {
        range.end = ranges[i + 1].end
        ranges.splice(i + 1, 1)
      }
      return
    }
    if (seq < range.start) {
      insertIdx = i
      break
    }
    insertIdx = i + 1
  }

  // Insert new single-element range
  ranges.splice(insertIdx, 0, { start: seq, end: seq })
}

/**
 * Checks if a sequence number is in tombstones.
 */
export function isInTombstones(
  tombstones: Map<string, TombstoneRange[]>,
  clientId: string,
  seq: number
): boolean {
  const ranges = tombstones.get(clientId)
  if (!ranges) return false
  for (const range of ranges) {
    if (seq >= range.start && seq <= range.end) return true
    if (seq < range.start) break
  }
  return false
}

/**
 * Encoded update structure with minified keys for smaller wire size.
 * Maps mapName -> { a: active entries, t: tombstones }
 */
export interface EncodedUpdate {
  // mapName -> map data
  [mapName: string]: {
    /** a = active entries: Array<{ k: key, v: value }> */
    a: Array<{ k: string; v: JSONValue }>
    /** t = tombstones: Record<clientId, encodedRanges> */
    t: Record<string, number[]>
  }
}

/**
 * Encodes a full state update.
 */
export function encodeFullState(
  maps: Map<string, MapStore>,
  targetVector?: StateVector
): EncodedUpdate {
  const update: EncodedUpdate = {}

  for (const [mapName, store] of maps) {
    const activeEntries: Array<{ k: string; v: JSONValue }> = []
    const tombstoneData: Record<string, number[]> = {}

    // Filter active entries based on target vector
    for (const [key, entry] of store.active) {
      if (targetVector) {
        const targetMax = targetVector.get(entry.clientId) ?? -1
        if (entry.seq <= targetMax) continue // Target already has this
      }
      activeEntries.push({ k: key, v: entry.value })
    }

    // Encode tombstones (all ranges for now, could optimize with vector)
    for (const [clientId, ranges] of store.tombstones) {
      if (ranges.length > 0) {
        tombstoneData[clientId] = encodeRanges(ranges)
      }
    }

    if (activeEntries.length > 0 || Object.keys(tombstoneData).length > 0) {
      update[mapName] = { a: activeEntries, t: tombstoneData }
    }
  }

  return update
}

/**
 * Decodes and applies an update.
 * Returns the changes for each map.
 */
export function decodeAndApplyUpdate(
  update: EncodedUpdate,
  getOrCreateMap: (name: string) => MapStore
): Map<
  string,
  Map<string, { action: "add" | "delete"; oldValue?: JSONValue; newValue?: JSONValue }>
> {
  const allChanges = new Map<
    string,
    Map<string, { action: "add" | "delete"; oldValue?: JSONValue; newValue?: JSONValue }>
  >()

  for (const [mapName, mapData] of Object.entries(update)) {
    const store = getOrCreateMap(mapName)
    const changes = new Map<
      string,
      { action: "add" | "delete"; oldValue?: JSONValue; newValue?: JSONValue }
    >()

    // Apply tombstones first (t = tombstones)
    for (const [clientId, encodedRanges] of Object.entries(mapData.t)) {
      const ranges = decodeRanges(encodedRanges)
      for (const range of ranges) {
        for (let seq = range.start; seq <= range.end; seq++) {
          addToTombstones(store.tombstones, clientId, seq)
        }
      }
    }

    // Apply active entries (a = active, k = key, v = value)
    for (const entry of mapData.a) {
      const parsed = parseKey(entry.k) // Throws on invalid key

      // Check if tombstoned
      if (isInTombstones(store.tombstones, parsed.clientId, parsed.seq)) {
        continue
      }

      // Check if already exists
      if (store.active.has(entry.k)) {
        continue
      }

      store.active.set(entry.k, {
        key: entry.k,
        value: entry.v,
        clientId: parsed.clientId,
        seq: parsed.seq,
      })
      changes.set(entry.k, { action: "add", newValue: entry.v })
    }

    // Check if any active entries are now tombstoned
    for (const [key, activeEntry] of store.active) {
      if (isInTombstones(store.tombstones, activeEntry.clientId, activeEntry.seq)) {
        store.active.delete(key)
        changes.set(key, { action: "delete", oldValue: activeEntry.value })
      }
    }

    if (changes.size > 0) {
      allChanges.set(mapName, changes)
    }
  }

  return allChanges
}

/**
 * Computes the state vector from all maps.
 */
export function computeStateVector(maps: Map<string, MapStore>): StateVector {
  const sv: StateVector = new Map()

  for (const store of maps.values()) {
    // Include active entries
    for (const entry of store.active.values()) {
      const current = sv.get(entry.clientId) ?? -1
      if (entry.seq > current) {
        sv.set(entry.clientId, entry.seq)
      }
    }
    // Include tombstones
    for (const [clientId, ranges] of store.tombstones) {
      if (ranges.length > 0) {
        const maxSeq = ranges[ranges.length - 1].end
        const current = sv.get(clientId) ?? -1
        if (maxSeq > current) {
          sv.set(clientId, maxSeq)
        }
      }
    }
  }

  return sv
}
