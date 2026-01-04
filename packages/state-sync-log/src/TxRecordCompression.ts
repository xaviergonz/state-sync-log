import { failure } from "./error"
import type { JSONValue } from "./json"
import type { Op } from "./operations"
import type { TxRecord } from "./TxRecord"
import type { TxTimestampKey } from "./txTimestamp"

/**
 * Encoded operation format.
 * Discriminated by the first element (kind code):
 * - 0: set [0, path, key, value]
 * - 1: delete [1, path, key]
 * - 2: splice [2, path, index, deleteCount, inserts]
 * - 3: addToSet [3, path, value]
 * - 4: deleteFromSet [4, path, value]
 */
export type EncodedOp =
  | [0, Op["path"], string | number, unknown] // set
  | [1, Op["path"], string | number] // delete
  | [2, Op["path"], number, number, unknown[]] // splice
  | [3, Op["path"], unknown] // addToSet
  | [4, Op["path"], unknown] // deleteFromSet

/**
 * Encoded transaction record format.
 * - [0]: ops array (encoded)
 * - [1]: originalTxKey (optional, omit if undefined)
 */
export type EncodedTxRecord = [EncodedOp[]] | [EncodedOp[], TxTimestampKey]

const OP_SET = 0 as const
const OP_DELETE = 1 as const
const OP_SPLICE = 2 as const
const OP_ADD_TO_SET = 3 as const
const OP_DELETE_FROM_SET = 4 as const

/**
 * Encodes an Op to its compact array form.
 */
function encodeOp(op: Op): EncodedOp {
  switch (op.kind) {
    case "set":
      return [OP_SET, op.path, op.key, op.value]
    case "delete":
      return [OP_DELETE, op.path, op.key]
    case "splice":
      return [OP_SPLICE, op.path, op.index, op.deleteCount, op.inserts as unknown[]]
    case "addToSet":
      return [OP_ADD_TO_SET, op.path, op.value]
    case "deleteFromSet":
      return [OP_DELETE_FROM_SET, op.path, op.value]
    default: {
      // Exhaustive check - TypeScript will error if a case is missing
      const _exhaustive: never = op
      failure(`Unknown op kind: ${(_exhaustive as Op).kind}`)
    }
  }
}

/**
 * Decodes an EncodedOp back to an Op.
 */
function decodeOp(encoded: EncodedOp): Op {
  switch (encoded[0]) {
    case OP_SET:
      return { kind: "set", path: encoded[1], key: encoded[2], value: encoded[3] as JSONValue }
    case OP_DELETE:
      return { kind: "delete", path: encoded[1], key: encoded[2] }
    case OP_SPLICE:
      return {
        kind: "splice",
        path: encoded[1],
        index: encoded[2],
        deleteCount: encoded[3],
        inserts: encoded[4] as JSONValue[],
      }
    case OP_ADD_TO_SET:
      return { kind: "addToSet", path: encoded[1], value: encoded[2] as JSONValue }
    case OP_DELETE_FROM_SET:
      return { kind: "deleteFromSet", path: encoded[1], value: encoded[2] as JSONValue }
    default: {
      // Exhaustive check - TypeScript will error if a case is missing
      const _exhaustive: never = encoded[0]
      failure(`Unknown encoded op kind: ${_exhaustive}`)
    }
  }
}

/**
 * Encodes a TxRecord to its compact array form.
 */
export function encodeTxRecord(record: TxRecord): EncodedTxRecord {
  const encodedOps = record.ops.map(encodeOp)
  if (record.originalTxKey !== undefined) {
    return [encodedOps, record.originalTxKey]
  }
  return [encodedOps]
}

/**
 * Decodes an EncodedTxRecord back to a TxRecord.
 */
export function decodeTxRecord(encoded: EncodedTxRecord): TxRecord {
  const ops = encoded[0].map(decodeOp)
  if (encoded.length > 1) {
    return { ops, originalTxKey: encoded[1] }
  }
  return { ops }
}
