/**
 * Utility functions for proxy drafts.
 * Adapted from mutative - removed Map/Set support, mark, deepFreeze.
 */

import { failure } from "../error"
import { PROXY_DRAFT } from "./constant"
import { DraftType, type ProxyDraft } from "./interface"

// ============================================================================
// Core Draft Utilities
// ============================================================================

/**
 * Get the latest value (copy if exists, otherwise original)
 */
export function latest<T>(proxyDraft: ProxyDraft<T>): T {
  return (proxyDraft.copy ?? proxyDraft.original) as T
}

/**
 * Check if the value is a draft
 */
export function isDraft(target: unknown): boolean {
  return !!getProxyDraft(target)
}

/**
 * Get the ProxyDraft from a draft value
 */
export function getProxyDraft<T>(value: unknown): ProxyDraft<T> | null {
  if (typeof value !== "object" || value === null) return null
  return (value as { [PROXY_DRAFT]?: ProxyDraft<T> })[PROXY_DRAFT] ?? null
}

/**
 * Get the actual value from a draft (copy or original)
 */
export function getValue<T extends object>(value: T): T {
  const proxyDraft = getProxyDraft(value)
  return proxyDraft ? ((proxyDraft.copy ?? proxyDraft.original) as T) : value
}

/**
 * Check if a value is draftable (plain object or array)
 * We only support plain objects and arrays - no Map, Set, Date, etc.
 */
export function isDraftable(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false
  return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype
}

/**
 * Get the draft type
 */
export function getType(target: unknown): DraftType {
  return Array.isArray(target) ? DraftType.Array : DraftType.Object
}

/**
 * Get a value by key
 */
export function get(target: object, key: PropertyKey): unknown {
  return (target as Record<PropertyKey, unknown>)[key]
}

/**
 * Set a value by key
 */
export function set(target: object, key: PropertyKey, value: unknown): void {
  ;(target as Record<PropertyKey, unknown>)[key] = value
}

/**
 * Check if a key exists (own property)
 */
export function has(target: object, key: PropertyKey): boolean {
  return Object.hasOwn(target, key as string)
}

/**
 * Peek at a value (through drafts)
 */
export function peek(target: object, key: PropertyKey): unknown {
  const state = getProxyDraft(target)
  const source = state ? latest(state) : target
  return (source as Record<PropertyKey, unknown>)[key]
}

/**
 * SameValue comparison (handles -0 and NaN)
 */
export function isEqual(x: unknown, y: unknown): boolean {
  if (x === y) {
    return x !== 0 || 1 / (x as number) === 1 / (y as number)
  }
  // biome-ignore lint/suspicious/noSelfCompare: NaN check pattern (NaN !== NaN)
  return x !== x && y !== y
}

/**
 * Revoke all proxies in a draft tree
 */
export function revokeProxy(proxyDraft: ProxyDraft | null): void {
  if (!proxyDraft) return
  while (proxyDraft.finalities.revoke.length > 0) {
    const revoke = proxyDraft.finalities.revoke.pop()!
    revoke()
  }
}

/**
 * Get the path from root to this draft
 */
export function getPath(
  target: ProxyDraft,
  path: (string | number)[] = []
): (string | number)[] | null {
  if (Object.hasOwn(target, "key") && target.key !== undefined) {
    // Check if the parent still has this draft at this key
    const parentCopy = target.parent?.copy
    if (parentCopy) {
      const proxyDraft = getProxyDraft(get(parentCopy as object, target.key))
      if (proxyDraft !== null && proxyDraft.original !== target.original) {
        return null
      }
    }
    path.push(target.key)
  }
  if (target.parent) {
    return getPath(target.parent, path)
  }
  // target is root draft
  path.reverse()
  return path
}

/**
 * Get the path from root to this draft, or throw if not available
 */
export function getPathOrThrow(target: ProxyDraft): (string | number)[] {
  const path = getPath(target)
  if (!path) {
    failure("Cannot determine path for operation")
  }
  return path
}

/**
 * Find all paths to a given draft by searching the tree.
 * This handles aliasing where the same draft exists at multiple positions.
 */
export function getAllPathsForDraft(
  rootDraft: ProxyDraft,
  targetDraft: ProxyDraft
): (string | number)[][] {
  const result: (string | number)[][] = []

  function search(current: ProxyDraft, currentPath: (string | number)[]): void {
    if (current === targetDraft) {
      result.push([...currentPath])
      // Don't return - the same draft could be nested inside itself (unlikely but possible)
    }

    const source = latest(current) as Record<string | number, unknown>
    if (!source || typeof source !== "object") return

    const keys: (string | number)[] = Array.isArray(source)
      ? Array.from({ length: source.length }, (_, i) => i)
      : Object.keys(source)

    for (const key of keys) {
      const value = source[key]
      const childDraft = getProxyDraft(value)
      if (childDraft) {
        search(childDraft, [...currentPath, key])
      }
    }
  }

  search(rootDraft, [])
  return result
}

/**
 * Get a property descriptor from the prototype chain
 */
export function getDescriptor(target: object, key: PropertyKey): PropertyDescriptor | undefined {
  if (key in target) {
    let prototype = Reflect.getPrototypeOf(target)
    while (prototype) {
      const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key)
      if (descriptor) return descriptor
      prototype = Reflect.getPrototypeOf(prototype)
    }
  }
  return undefined
}

// ============================================================================
// Copy Utilities
// ============================================================================

const propIsEnum = Object.prototype.propertyIsEnumerable

/**
 * Create a shallow copy of an object or array
 */
export function shallowCopy<T>(original: T): T {
  if (Array.isArray(original)) {
    return Array.prototype.concat.call(original) as T
  }
  // Plain object - use optimized copy
  const copy: Record<string | symbol, unknown> = {}
  for (const key of Object.keys(original as object)) {
    copy[key] = (original as Record<string, unknown>)[key]
  }
  for (const key of Object.getOwnPropertySymbols(original as object)) {
    if (propIsEnum.call(original, key)) {
      copy[key] = (original as Record<symbol, unknown>)[key]
    }
  }
  return copy as T
}

/**
 * Ensure a draft has a shallow copy
 */
export function ensureShallowCopy(target: ProxyDraft): void {
  if (target.copy) return
  target.copy = shallowCopy(target.original)
  target.assignedMap = target.assignedMap ?? new Map()
}

/**
 * Deep clone a value, unwrapping any drafts
 */
export function deepClone<T>(target: T): T {
  if (!isDraftable(target)) {
    return isDraft(target) ? (getValue(target as object) as T) : target
  }
  if (Array.isArray(target)) {
    return target.map(deepClone) as T
  }
  const copy: Record<string, unknown> = {}
  for (const key in target) {
    if (has(target, key)) {
      copy[key] = deepClone((target as Record<string, unknown>)[key])
    }
  }
  return copy as T
}

/**
 * Clone if the value is a draft, otherwise return as-is
 */
export function cloneIfNeeded<T>(target: T): T {
  return isDraft(target) ? deepClone(target) : target
}

// ============================================================================
// Draft State Utilities
// ============================================================================

/**
 * Mark a draft as changed (operated)
 */
export function markChanged(target: ProxyDraft): void {
  if (!target.operated) {
    target.operated = true
    if (target.parent) {
      markChanged(target.parent)
    }
  }
}

/**
 * Iterate over object/array entries
 */
export function forEach<T extends object>(
  target: T,
  callback: (key: PropertyKey, value: unknown, target: T) => void
): void {
  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      callback(i, target[i], target)
    }
  } else {
    for (const key of Reflect.ownKeys(target)) {
      callback(key, (target as Record<PropertyKey, unknown>)[key], target)
    }
  }
}

// ============================================================================
// Finalization Utilities
// ============================================================================

/**
 * Handle nested values during finalization
 */
export function handleValue(target: unknown, handledSet: WeakSet<object>): void {
  if (
    !isDraftable(target) ||
    isDraft(target) ||
    handledSet.has(target as object) ||
    Object.isFrozen(target)
  ) {
    return
  }

  handledSet.add(target as object)

  forEach(target as object, (key, value) => {
    if (isDraft(value)) {
      const proxyDraft = getProxyDraft(value)!
      ensureShallowCopy(proxyDraft)
      const updatedValue =
        proxyDraft.assignedMap?.size || proxyDraft.operated ? proxyDraft.copy : proxyDraft.original
      set(target as object, key, updatedValue)
    } else {
      handleValue(value, handledSet)
    }
  })
}
