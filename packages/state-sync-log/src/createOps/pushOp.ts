/**
 * Eager op generation - ops are pushed immediately when mutations happen.
 *
 * This module provides the pushOp function that records operations at mutation time,
 * rather than diffing at finalization time.
 *
 * When a draft exists at multiple positions (aliasing), ops are emitted for ALL positions
 * to ensure consistency when applied.
 */

import { failure } from "../error"
import type { Op, ProxyDraft } from "./interface"
import { getAllPathsForDraft } from "./utils"

/**
 * Push an operation to the ops log.
 * Values should already be cloned by the caller to avoid aliasing issues.
 *
 * When the target draft exists at multiple positions (due to aliasing),
 * this function emits ops for all positions to maintain consistency.
 */
export function pushOp(proxyDraft: ProxyDraft, op: Op): void {
  const rootDraft = proxyDraft.finalities.rootDraft
  if (!rootDraft) {
    failure("rootDraft is not set - cannot emit op")
  }

  // Fast path: no aliasing, just emit the single op
  if (proxyDraft.aliasCount <= 1) {
    proxyDraft.finalities.ops.push(op)
    return
  }

  // Slow path: draft exists at multiple positions, find all paths
  const allPaths = getAllPathsForDraft(rootDraft, proxyDraft)

  // Emit the op for each path where this draft exists
  for (const path of allPaths) {
    const adjustedOp = { ...op, path }
    proxyDraft.finalities.ops.push(adjustedOp)
  }
}
