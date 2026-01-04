import { failure } from "./error"
import { JSONObject, JSONValue, Path } from "./json"
import { deepClone, deepEqual, isObject, parseArrayIndex } from "./utils"

/**
 * Supported operations.
 * Applied sequentially within a tx.
 */
export type Op =
  | { kind: "set"; path: Path; key: string | number; value: JSONValue }
  | { kind: "delete"; path: Path; key: string | number }
  | { kind: "splice"; path: Path; index: number; deleteCount: number; inserts: JSONValue[] }
  | { kind: "addToSet"; path: Path; value: JSONValue }
  | { kind: "deleteFromSet"; path: Path; value: JSONValue }

/**
 * Validation function type.
 *
 * Rules:
 * - Validation MUST depend only on candidateState (and deterministic code).
 * - Validation runs once per tx, after all ops apply.
 * - If validation fails, the x is rejected (state reverts to previous).
 * - If no validator is provided, validation defaults to true.
 *
 * IMPORTANT: Validation outcome is **derived local state** and MUST NOT be replicated.
 * All clients MUST use the same validation logic to ensure consistency.
 */
export type ValidateFn<State extends JSONObject> = (candidateState: State) => boolean

/**
 * Resolves a path within the state.
 * Throws if any segment is missing or has wrong type.
 */
function resolvePath(state: JSONObject, path: Path): JSONValue {
  let current: JSONValue = state
  for (const segment of path) {
    if (typeof segment === "string") {
      if (!isObject(current) || Array.isArray(current)) {
        failure(`Expected object at path segment "${segment}"`)
      }
      if (!(segment in current)) {
        failure(`Property "${segment}" does not exist`)
      }
      current = current[segment]
    } else {
      if (!Array.isArray(current)) {
        failure(`Expected array at path segment ${segment}`)
      }
      if (segment < 0 || segment >= current.length) {
        failure(`Index ${segment} out of bounds`)
      }
      current = current[segment]
    }
  }
  return current
}

/**
 * Applies a single operation.
 * (Reference implementation for standard JSON-patch behavior)
 */
function applyOp(state: JSONObject, op: Op, cloneValues: boolean): void {
  // Special case: if path is empty, we can't resolve "container".
  // The caller must handle root-level replacement if necessary, but
  // standard Ops usually act ON a container.
  // Exception: if we act on root, handle explicitly or assume path length > 0.
  // For this spec, Ops modify *fields* or *indices*.
  // If path is empty, it means we are acting ON the root object itself?
  // The spec's "set" example: container[op.key] = op.value.
  // This implies we resolve path to get the PARENT container.

  const container = resolvePath(state, op.path)

  switch (op.kind) {
    case "set": {
      // Allow object or array container
      if (!isObject(container)) {
        failure("set requires object or array container")
      }
      let key: string | number = op.key
      // For arrays, convert string keys to numbers (except "length")
      if (Array.isArray(container) && typeof key === "string" && key !== "length") {
        const numKey = parseArrayIndex(key)
        if (numKey === null) {
          failure(`Cannot set non-numeric property "${key}" on array`)
        }
        key = numKey
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(container as any)[key] = cloneValues ? deepClone(op.value) : op.value
      break
    }

    case "delete": {
      // Allow object or array (sparse delete?)
      if (!isObject(container)) {
        failure("delete requires object or array container")
      }
      let key: string | number = op.key
      // For arrays, convert string keys to numbers
      if (Array.isArray(container) && typeof key === "string") {
        const numKey = parseArrayIndex(key)
        if (numKey === null) {
          failure(`Cannot delete non-numeric property "${key}" from array`)
        }
        key = numKey
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (container as any)[key]
      break
    }

    case "splice": {
      if (!Array.isArray(container)) {
        failure("splice requires array container")
      }
      const safeIndex = Math.min(op.index, container.length)
      container.splice(
        safeIndex,
        op.deleteCount,
        ...(cloneValues ? op.inserts.map((v) => deepClone(v)) : op.inserts)
      )
      break
    }

    case "addToSet":
      if (!Array.isArray(container)) {
        failure("addToSet requires array container")
      }
      if (!container.some((item) => deepEqual(item, op.value))) {
        container.push(cloneValues ? deepClone(op.value) : op.value)
      }
      break

    case "deleteFromSet":
      if (!Array.isArray(container)) {
        failure("deleteFromSet requires array container")
      }
      // Remove all matching items using splice (from end to avoid index shifting)
      for (let i = container.length - 1; i >= 0; i--) {
        if (deepEqual(container[i], op.value)) {
          container.splice(i, 1)
        }
      }
      break

    default:
      failure(`Unknown operation kind: ${(op as any).kind}`)
  }
}

/**
 * Options for applyOps.
 */
export interface ApplyOpsOptions {
  /**
   * Whether to deep clone values before inserting them into the target.
   * - `true` (default): Values are cloned to prevent aliasing between the ops and target.
   * - `false`: Values are used directly for better performance. Only use this if you
   *   guarantee the op values won't be mutated after application.
   */
  cloneValues?: boolean
}

/**
 * Applies a list of operations to a mutable target object.
 * Use this to synchronize an external mutable state (e.g., MobX store)
 * with the operations received via subscribe().
 *
 * @param ops - The list of operations to apply.
 * @param target - The mutable object to modify.
 * @param options - Optional settings for controlling cloning behavior.
 */
export function applyOps(ops: readonly Op[], target: JSONObject, options?: ApplyOpsOptions): void {
  const cloneValues = options?.cloneValues ?? true
  for (const op of ops) {
    applyOp(target, op, cloneValues)
  }
}
