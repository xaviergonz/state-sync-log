import { failure } from "../error"
import { JSONValue } from "../json"
import { ActiveEntry, addToTombstones, isInTombstones, MapStore, parseKey } from "./SyncLogEncoding"

/**
 * Observer callback for map changes.
 */
export type SyncLogMapObserver = (event: SyncLogMapEvent, txOrigin: unknown) => void

/**
 * Event emitted when map changes.
 */
export interface SyncLogMapEvent {
  changes: {
    keys: Map<string, { action: "add" | "delete"; oldValue?: JSONValue; newValue?: JSONValue }>
  }
}

/**
 * Internal interface for the owning document.
 */
interface SyncLogMapOwner {
  isInTransaction(): boolean
  queueMapChange(
    mapName: string,
    key: string,
    change: { action: "add" | "delete"; oldValue?: JSONValue; newValue?: JSONValue }
  ): void
  getCurrentOrigin(): unknown
  emitSingleChange(
    mapName: string,
    key: string,
    change: { action: "add" | "delete"; oldValue?: JSONValue; newValue?: JSONValue }
  ): void
}

/**
 * A CRDT map optimized for set-once keys with range-based tombstone compression.
 */
export class SyncLogMap {
  private readonly _name: string
  private readonly _store: MapStore
  private readonly _owner: SyncLogMapOwner
  private readonly _observers: Set<SyncLogMapObserver> = new Set()

  constructor(name: string, store: MapStore, owner: SyncLogMapOwner) {
    this._name = name
    this._store = store
    this._owner = owner
  }

  /**
   * Gets the value for a key.
   */
  get(key: string): JSONValue | undefined {
    const entry = this._store.active.get(key)
    return entry?.value
  }

  /**
   * Sets a value for a key.
   * Throws if key already exists or doesn't match expected format.
   */
  set(key: string, value: JSONValue): void {
    const { clientId, seq } = parseKey(key)

    // Check if tombstoned
    if (isInTombstones(this._store.tombstones, clientId, seq)) {
      failure(`Cannot set tombstoned key: "${key}"`)
    }

    // Check if already exists
    if (this._store.active.has(key)) {
      failure(`Key already exists: "${key}"`)
    }

    const entry: ActiveEntry = { key, value, clientId, seq }
    this._store.active.set(key, entry)

    this._notifyChange(key, { action: "add", newValue: value })
  }

  /**
   * Deletes a key.
   * Throws if key format is invalid.
   * Returns true if the key existed.
   */
  delete(key: string): boolean {
    const { clientId, seq } = parseKey(key) // Throws on invalid key format

    const entry = this._store.active.get(key)
    if (!entry) {
      // Still track as tombstone for CRDT consistency
      addToTombstones(this._store.tombstones, clientId, seq)
      return false
    }

    this._store.active.delete(key)
    addToTombstones(this._store.tombstones, entry.clientId, entry.seq)

    this._notifyChange(key, { action: "delete", oldValue: entry.value })
    return true
  }

  /**
   * Checks if a key exists.
   */
  has(key: string): boolean {
    return this._store.active.has(key)
  }

  /**
   * Returns the number of active entries.
   */
  get size(): number {
    return this._store.active.size
  }

  /**
   * Iterates over keys.
   */
  *keys(): IterableIterator<string> {
    for (const key of this._store.active.keys()) {
      yield key
    }
  }

  /**
   * Iterates over values.
   */
  *values(): IterableIterator<JSONValue> {
    for (const entry of this._store.active.values()) {
      yield entry.value
    }
  }

  /**
   * Iterates over entries.
   */
  *entries(): IterableIterator<[string, JSONValue]> {
    for (const entry of this._store.active.values()) {
      yield [entry.key, entry.value]
    }
  }

  /**
   * Default iterator.
   */
  [Symbol.iterator](): IterableIterator<[string, JSONValue]> {
    return this.entries()
  }

  /**
   * Subscribes to changes.
   * Returns a function to unsubscribe.
   */
  observe(callback: SyncLogMapObserver): () => void {
    this._observers.add(callback)
    return () => this._observers.delete(callback)
  }

  /**
   * Internal: Notify observers of a change.
   */
  private _notifyChange(
    key: string,
    change: { action: "add" | "delete"; oldValue?: JSONValue; newValue?: JSONValue }
  ): void {
    if (this._owner.isInTransaction()) {
      this._owner.queueMapChange(this._name, key, change)
    } else {
      this._owner.emitSingleChange(this._name, key, change)
    }
  }

  /**
   * Internal: Emit event to observers.
   */
  _emitEvent(
    changes: Map<string, { action: "add" | "delete"; oldValue?: JSONValue; newValue?: JSONValue }>
  ): void {
    if (changes.size === 0) return
    const event: SyncLogMapEvent = { changes: { keys: changes } }
    const origin = this._owner.getCurrentOrigin()
    for (const observer of this._observers) {
      observer(event, origin)
    }
  }
}
