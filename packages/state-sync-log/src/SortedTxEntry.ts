import { SyncLogMap } from "./crdt/SyncLogMap"
import { failure } from "./error"
import { TxRecord } from "./TxRecord"
import { parseTxTimestampKey, type TxTimestamp, type TxTimestampKey } from "./txTimestamp"

/**
 * A cached tx entry with lazy parsing and optional tx caching.
 * The timestamp is parsed on first access and cached.
 * The tx record can be fetched lazily and cached.
 */
export class SortedTxEntry {
  private _txTimestamp?: TxTimestamp
  private _originalTxTimestampKey?: TxTimestampKey | null
  private _originalTxTimestamp?: TxTimestamp | null
  private _txRecord?: TxRecord

  constructor(
    readonly txTimestampKey: TxTimestampKey,
    private readonly _txMap: SyncLogMap<TxRecord>
  ) {}

  /**
   * Gets the parsed timestamp, lazily parsing and caching on first access.
   */
  get txTimestamp(): TxTimestamp {
    if (!this._txTimestamp) {
      this._txTimestamp = parseTxTimestampKey(this.txTimestampKey)
    }
    return this._txTimestamp
  }

  /**
   * Gets the original tx timestamp key, lazily and caching on first access.
   */
  get originalTxTimestampKey(): TxTimestampKey | null {
    if (this._originalTxTimestampKey === undefined) {
      const tx = this.txRecord
      this._originalTxTimestampKey = tx.originalTxKey ?? null
    }
    return this._originalTxTimestampKey
  }

  /**
   * Gets the parsed original tx timestamp, lazily parsing and caching on first access.
   */
  get originalTxTimestamp(): TxTimestamp | null {
    if (this._originalTxTimestamp === undefined) {
      const key = this.originalTxTimestampKey
      this._originalTxTimestamp = key ? parseTxTimestampKey(key) : null
    }
    return this._originalTxTimestamp
  }

  /**
   * Gets the logical (deduplicated) tx timestamp key.
   * This is the original tx key if it exists, otherwise the physical key.
   */
  get dedupTxTimestampKey(): TxTimestampKey {
    return this.originalTxTimestampKey ?? this.txTimestampKey
  }

  /**
   * Gets the logical (deduplicated) parsed tx timestamp.
   * This is the original tx timestamp if it exists, otherwise the physical timestamp.
   */
  get dedupTxTimestamp(): TxTimestamp {
    return this.originalTxTimestamp ?? this.txTimestamp
  }

  /**
   * Gets the tx record, lazily fetching and caching on first access.
   * Returns undefined if the tx doesn't exist.
   */
  get txRecord(): TxRecord {
    if (!this._txRecord) {
      this._txRecord = this._txMap.get(this.txTimestampKey)
      if (!this._txRecord) {
        failure(`SortedTxEntry: TxRecord not found for key ${this.txTimestampKey}`)
      }
    }
    return this._txRecord
  }
}
