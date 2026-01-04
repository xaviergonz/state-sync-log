import { failure } from "./error"
import type { JSONObject, JSONRecord, JSONValue, Path } from "./json"
import type { Op, ValidateFn } from "./operations"
import { TxRecord } from "./TxRecord"
import { deepEqual, isObject, parseArrayIndex } from "./utils"

/**
 * A draft context for copy-on-write immutable updates.
 *
 * This provides Immer/Mutative-like semantics without the proxy overhead:
 * - The original base state is never mutated
 * - Objects are cloned lazily on first mutation (copy-on-write)
 * - Once an object is cloned ("owned"), it can be mutated directly
 * - If no changes are made, the original reference is preserved (structural sharing)
 */
export interface DraftContext<T extends JSONObject> {
  /** The current root (may be the original base or a cloned version) */
  root: T
  /** The original base state (never mutated) */
  base: T
  /** Set of objects that have been cloned and are safe to mutate */
  ownedObjects: WeakSet<object>
  /** Optimization: fast check if root is already owned */
  isRootOwned: boolean
}

/**
 * Creates a new draft context from a base state.
 * The base state will never be mutated.
 */
export function createDraft<T extends JSONObject>(base: T): DraftContext<T> {
  return {
    root: base,
    base,
    ownedObjects: new Set(),
    isRootOwned: false,
  }
}

/**
 * Checks if the draft was modified (root !== base).
 */
export function isDraftModified<T extends JSONObject>(ctx: DraftContext<T>): boolean {
  return ctx.root !== ctx.base
}

function shallowClone<T extends object>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.slice() as unknown as T
  }
  const clone = {} as T
  const keys = Object.keys(obj)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    ;(clone as any)[key] = (obj as any)[key]
  }
  return clone
}

/**
 * Ensures an object is owned (cloned if necessary) and returns the owned version.
 * Also updates the parent to point to the cloned child.
 */
function ensureOwned<T extends JSONObject>(
  ctx: DraftContext<T>,
  parent: JSONObject,
  key: string | number,
  child: JSONRecord | JSONValue[]
): JSONRecord | JSONValue[] {
  if (ctx.ownedObjects.has(child)) {
    return child
  }
  const cloned = shallowClone(child)
  ;(parent as any)[key] = cloned
  ctx.ownedObjects.add(cloned)
  return cloned
}

/**
 * Ensures all objects along the path are owned (cloned if necessary).
 * Returns the container at the end of the path.
 * Throws if the path is invalid.
 */
function ensureOwnedPath<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path
): JSONRecord | JSONValue[] {
  // Ensure root is owned first
  if (!ctx.isRootOwned) {
    ctx.root = shallowClone(ctx.root as unknown as object) as T
    ctx.ownedObjects.add(ctx.root)
    ctx.isRootOwned = true
  }

  if (path.length === 0) {
    return ctx.root
  }

  let current: JSONRecord | JSONValue[] = ctx.root

  for (let i = 0; i < path.length; i++) {
    const segment = path[i]
    const isArrayIndex = typeof segment === "number"

    // Validate container type
    if (isArrayIndex) {
      if (!Array.isArray(current)) {
        failure(`Expected array at path segment ${segment}`)
      }
      if (segment < 0 || segment >= current.length) {
        failure(`Index ${segment} out of bounds`)
      }
    } else {
      if (!isObject(current) || Array.isArray(current)) {
        failure(`Expected object at path segment "${segment}"`)
      }
      if (!(segment in current)) {
        failure(`Property "${segment}" does not exist`)
      }
    }

    const child: JSONValue = (current as any)[segment]

    // Validate child is traversable
    if (child === null || typeof child !== "object") {
      failure(`Cannot traverse through primitive at path segment ${segment}`)
    }

    // Ensure child is owned and continue
    current = ensureOwned(ctx, current, segment, child as JSONRecord | JSONValue[])
  }

  return current
}

/**
 * Applies a single "set" operation to the draft with copy-on-write.
 */
export function draftSet<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  key: string | number,
  value: JSONValue
): void {
  const container = ensureOwnedPath(ctx, path)
  if (!isObject(container)) {
    failure("set requires object or array container")
  }
  let finalKey: string | number = key
  // For arrays, convert string keys to numbers (except "length")
  if (Array.isArray(container) && typeof key === "string" && key !== "length") {
    const numKey = parseArrayIndex(key)
    if (numKey === null) {
      failure(`Cannot set non-numeric property "${key}" on array`)
    }
    finalKey = numKey
  }
  ;(container as Record<string | number, JSONValue>)[finalKey] = value
}

/**
 * Applies a single "delete" operation to the draft with copy-on-write.
 */
export function draftDelete<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  key: string | number
): void {
  const container = ensureOwnedPath(ctx, path)
  if (!isObject(container)) {
    failure("delete requires object or array container")
  }
  let finalKey: string | number = key
  // For arrays, convert string keys to numbers
  if (Array.isArray(container) && typeof key === "string") {
    const numKey = parseArrayIndex(key)
    if (numKey === null) {
      failure(`Cannot delete non-numeric property "${key}" from array`)
    }
    finalKey = numKey
  }
  delete (container as Record<string | number, JSONValue>)[finalKey]
}

/**
 * Applies a single "splice" operation to the draft with copy-on-write.
 */
export function draftSplice<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  index: number,
  deleteCount: number,
  inserts: readonly JSONValue[]
): void {
  const container = ensureOwnedPath(ctx, path)
  if (!Array.isArray(container)) {
    failure("splice requires array container")
  }
  const safeIndex = Math.min(index, container.length)
  if (inserts.length === 0) {
    container.splice(safeIndex, deleteCount)
  } else if (inserts.length === 1) {
    container.splice(safeIndex, deleteCount, inserts[0])
  } else {
    container.splice(safeIndex, deleteCount, ...inserts)
  }
}

/**
 * Applies a single "addToSet" operation to the draft with copy-on-write.
 */
export function draftAddToSet<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  value: JSONValue
): void {
  const container = ensureOwnedPath(ctx, path)
  if (!Array.isArray(container)) {
    failure("addToSet requires array container")
  }
  if (!container.some((item) => deepEqual(item, value))) {
    container.push(value)
  }
}

/**
 * Applies a single "deleteFromSet" operation to the draft with copy-on-write.
 */
export function draftDeleteFromSet<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  value: JSONValue
): void {
  const container = ensureOwnedPath(ctx, path)
  if (!Array.isArray(container)) {
    failure("deleteFromSet requires array container")
  }
  // Remove all matching items (iterate backwards to avoid index shifting)
  for (let i = container.length - 1; i >= 0; i--) {
    if (deepEqual(container[i], value)) {
      container.splice(i, 1)
    }
  }
}

/**
 * Applies a single operation to the draft with copy-on-write.
 */
export function applyOpToDraft<T extends JSONObject>(ctx: DraftContext<T>, op: Op): void {
  switch (op.kind) {
    case "set":
      draftSet(ctx, op.path, op.key, op.value)
      break
    case "delete":
      draftDelete(ctx, op.path, op.key)
      break
    case "splice":
      draftSplice(ctx, op.path, op.index, op.deleteCount, op.inserts)
      break
    case "addToSet":
      draftAddToSet(ctx, op.path, op.value)
      break
    case "deleteFromSet":
      draftDeleteFromSet(ctx, op.path, op.value)
      break
    default:
      failure(`Unknown operation kind: ${(op as any).kind}`)
  }
}

/**
 * Applies a single transaction to a base state immutably.
 *
 * Key benefits over Mutative/Immer:
 * - No proxy overhead - direct object access and copy-on-write cloning
 * - Structural sharing - unchanged subtrees keep their references
 * - Zero-copy on failure - if validation fails, returns original base unchanged
 *
 * @param base - The base state (never mutated)
 * @param tx - The transaction to apply
 * @param validateFn - Optional validation function
 * @returns The final state (if valid) or the original base (if invalid or empty)
 */
export function applyTxImmutable<T extends JSONObject>(
  base: T,
  tx: Pick<TxRecord, "ops">,
  validateFn?: ValidateFn<T>
): T {
  if (tx.ops.length === 0) return base

  const ctx = createDraft(base)

  try {
    for (const op of tx.ops) {
      applyOpToDraft(ctx, op)
    }

    if (validateFn && !validateFn(ctx.root)) {
      return base
    }

    return ctx.root
  } catch {
    return base
  }
}
