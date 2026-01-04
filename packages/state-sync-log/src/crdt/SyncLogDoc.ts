import { JSONValue } from "../json"
import {
  computeStateVector,
  decodeAndApplyUpdate,
  EncodedUpdate,
  encodeFullState,
  MapStore,
  StateVector,
} from "./SyncLogEncoding"
import { SyncLogMap, SyncLogMapChange } from "./SyncLogMap"

/**
 * Update event callback.
 */
export type SyncLogDocUpdateHandler = (update: EncodedUpdate, origin: unknown) => void

/**
 * A CRDT document containing multiple named maps.
 * Optimized for set-once keys with range-based tombstone compression.
 */
export class SyncLogDoc {
  private readonly _maps: Map<string, SyncLogMap<any>> = new Map()
  private readonly _stores: Map<string, MapStore> = new Map()
  private readonly _updateHandlers: Set<SyncLogDocUpdateHandler> = new Set()

  // Transaction state
  private _inTransaction = false
  private _currentOrigin: unknown = undefined
  private _pendingChanges: Map<string, Map<string, SyncLogMapChange<JSONValue>>> = new Map()

  /**
   * Gets or creates a named map.
   * @typeParam T - The type of values stored in this map
   */
  getMap<T>(name: string): SyncLogMap<T> {
    let map = this._maps.get(name)
    if (!map) {
      const store = this._getOrCreateStore(name)
      map = new SyncLogMap<T>(name, store, this)
      this._maps.set(name, map)
    }
    return map as SyncLogMap<T>
  }

  /**
   * Executes a function within a transaction.
   * Changes are batched and emitted once at the end.
   */
  transact<R>(fn: () => R, origin?: unknown): R {
    if (this._inTransaction) {
      // Nested transaction - just execute
      return fn()
    }

    this._inTransaction = true
    this._currentOrigin = origin
    this._pendingChanges.clear()

    try {
      const result = fn()
      this._flushTransaction()
      return result
    } finally {
      this._inTransaction = false
      this._currentOrigin = undefined
      this._pendingChanges.clear()
    }
  }

  /**
   * Encodes the current state as an update.
   * If targetStateVector is provided, only includes changes the target doesn't have.
   */
  encodeStateAsUpdate(targetStateVector?: StateVector): EncodedUpdate {
    return encodeFullState(this._stores, targetStateVector)
  }

  /**
   * Applies an update from another document.
   */
  applyUpdate(update: EncodedUpdate, txOrigin?: unknown): void {
    this.transact(() => {
      const allChanges = decodeAndApplyUpdate(update, (name) => this._getOrCreateStore(name))

      // Emit events for each map and queue changes for doc-level update
      for (const [mapName, changes] of allChanges) {
        const map = this._maps.get(mapName)
        if (map) {
          map._emitEvent(changes)
        }
        // Also queue changes for doc-level onUpdate handlers
        for (const [key, change] of changes) {
          this.queueMapChange(mapName, key, change)
        }
      }
    }, txOrigin)
  }

  /**
   * Gets the current state vector (clientId -> max sequence seen).
   */
  getStateVector(): StateVector {
    return computeStateVector(this._stores)
  }

  /**
   * Subscribes to update events.
   * Returns a function to unsubscribe.
   */
  onUpdate(callback: SyncLogDocUpdateHandler): () => void {
    this._updateHandlers.add(callback)
    return () => this._updateHandlers.delete(callback)
  }

  /**
   * Garbage collects tombstones that are known to all peers.
   * Pass the minimum (laggiest) state vector from all connected peers.
   * Tombstones for sequences <= the minimum are safe to remove.
   */
  gc(minStateVector: StateVector): void {
    for (const store of this._stores.values()) {
      for (const [clientId, ranges] of store.tombstones) {
        const minSeq = minStateVector.get(clientId)
        if (minSeq === undefined) continue

        // Find first range that extends past minSeq
        let firstKeptIdx = 0
        while (firstKeptIdx < ranges.length && ranges[firstKeptIdx].end <= minSeq) {
          firstKeptIdx++
        }

        if (firstKeptIdx === 0) {
          // Check if first range needs partial trim
          if (ranges[0].start <= minSeq) {
            ranges[0] = { start: minSeq + 1, end: ranges[0].end }
          }
          // No ranges removed, nothing else to do
        } else if (firstKeptIdx >= ranges.length) {
          // All ranges are below minSeq
          store.tombstones.delete(clientId)
        } else {
          // Some ranges removed
          const newRanges = ranges.slice(firstKeptIdx)
          // Adjust first kept range if it partially overlaps
          if (newRanges[0].start <= minSeq) {
            newRanges[0] = { start: minSeq + 1, end: newRanges[0].end }
          }
          store.tombstones.set(clientId, newRanges)
        }
      }
    }
  }

  /**
   * Cleans up the document.
   */
  destroy(): void {
    this._maps.clear()
    this._stores.clear()
    this._updateHandlers.clear()
    this._pendingChanges.clear()
  }

  // --- SyncLogMapOwner interface ---

  isInTransaction(): boolean {
    return this._inTransaction
  }

  queueMapChange(mapName: string, key: string, change: SyncLogMapChange<JSONValue>): void {
    let mapChanges = this._pendingChanges.get(mapName)
    if (!mapChanges) {
      mapChanges = new Map()
      this._pendingChanges.set(mapName, mapChanges)
    }
    mapChanges.set(key, change)
  }

  getCurrentOrigin(): unknown {
    return this._currentOrigin
  }

  emitSingleChange(mapName: string, key: string, change: SyncLogMapChange<JSONValue>): void {
    // Emit map observer event
    const map = this._maps.get(mapName)
    if (map) {
      map._emitEvent(new Map([[key, change]]))
    }

    // Emit document update event with just this change (delta)
    if (this._updateHandlers.size > 0) {
      const update: EncodedUpdate =
        change.action === "add"
          ? { [mapName]: { a: [{ k: key, v: change.newValue }], t: {} } }
          : { [mapName]: { a: [], t: {} } } // Delete case - tombstone already in store
      for (const handler of this._updateHandlers) {
        handler(update, undefined)
      }
    }
  }

  // --- Private ---

  private _getOrCreateStore(name: string): MapStore {
    let store = this._stores.get(name)
    if (!store) {
      store = {
        active: new Map(),
        tombstones: new Map(),
      }
      this._stores.set(name, store)
    }
    return store
  }

  private _flushTransaction(): void {
    // Emit map observer events
    for (const [mapName, changes] of this._pendingChanges) {
      const map = this._maps.get(mapName)
      if (map && changes.size > 0) {
        map._emitEvent(changes)
      }
    }

    // Emit document update event with delta built from pending changes
    if (this._pendingChanges.size > 0 && this._updateHandlers.size > 0) {
      const update: EncodedUpdate = {}
      for (const [mapName, changes] of this._pendingChanges) {
        const active: Array<{ k: string; v: JSONValue }> = []
        for (const [key, change] of changes) {
          if (change.action === "add") {
            active.push({ k: key, v: change.newValue })
          }
        }
        if (active.length > 0) {
          update[mapName] = { a: active, t: {} }
        }
      }
      for (const handler of this._updateHandlers) {
        handler(update, this._currentOrigin)
      }
    }
  }
}
