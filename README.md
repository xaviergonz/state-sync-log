<p align="center">
  <img src="./logo.png" height="220" />
</p>
<p align="center">
  <i>State synchronization log for collaborative applications. <b>Validate every change before it happens.</b></i>
</p>

<p align="center">
  <a aria-label="NPM version" href="https://www.npmjs.com/package/state-sync-log">
    <img src="https://img.shields.io/npm/v/state-sync-log.svg?style=for-the-badge&logo=npm&labelColor=333" />
  </a>
  <a aria-label="License" href="./LICENSE">
    <img src="https://img.shields.io/npm/l/state-sync-log.svg?style=for-the-badge&labelColor=333" />
  </a>
  <a aria-label="Types" href="./packages/state-sync-log/tsconfig.json">
    <img src="https://img.shields.io/npm/types/state-sync-log.svg?style=for-the-badge&logo=typescript&labelColor=333" />
  </a>
  <br />
  <a aria-label="CI" href="https://github.com/xaviergonz/state-sync-log/actions/workflows/main.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/xaviergonz/state-sync-log/main.yml?branch=master&label=CI&logo=github&style=for-the-badge&labelColor=333" />
  </a>
  <a aria-label="Codecov" href="https://codecov.io/gh/xaviergonz/state-sync-log">
    <img src="https://img.shields.io/codecov/c/github/xaviergonz/state-sync-log?token=6MLRFUBK8V&label=codecov&logo=codecov&style=for-the-badge&labelColor=333" />
  </a>
</p>

## The Problem with Standard CRDTs

Tools like Yjs and Automerge are amazing for text editing because **they never reject a change**—they just merge everything.

But for **business applications**, most often than not we have rules where "merging everything" can result in a bug. For example, if you have a "WIP Limit" of 3 tasks in a Kanban board and users drag two tasks in at once, you end up with 4 tasks.

## The Solution: state-sync-log

`state-sync-log` is a **Validated Replicated State Machine** built on a custom, lightweight CRDT designed specifically for this use case. Unlike traditional CRDTs that merge everything:

**Every transaction is validated against your business logic before it is applied.**

If a peer sends an invalid transaction your clients **reject it strictly and deterministically**, even when the change itself was made while offline.

### Comparison

| Feature | state-sync-log | Standard CRDTs (Yjs, Automerge) |
| :--- | :---: | :---: |
| **Conflict Strategy** | 🫸 **Reject Invalid Changes** | 🔀 **Merge Everything** |
| **Data Model** | Plain JSON | Specialized Types (Y.Map, Y.Array) |
| **Validation** | ✅ First-class citizen | ❌ Not possible (by design) |
| **Best For** | Business logic, Forms, Games, CRUD, Complex editors | Text editing, Drawing, Notes |

---

## Example: Kanban Board with WIP Limits

Imagine a Kanban board where you strictly enforce a limit of **3 tasks** in the "Doing" column.

```ts
import { createStateSyncLog, SyncLogDoc } from "state-sync-log"

type Task = { id: string; title: string; status: "todo" | "doing" | "done" }
type State = { tasks: Task[] }

// 1. Define your business rules
const validate = (state: State) => {
  // RULE: Cannot have more than 3 tasks in 'doing'
  const doingCount = state.tasks.filter(t => t.status === "doing").length
  if (doingCount > 3) return false

  // RULE: Tasks must always have a title
  if (state.tasks.some(t => t.title.trim() === "")) return false

  return true
}

// 2. Initialize the log
const log = createStateSyncLog<State>({
  syncLogDoc: new SyncLogDoc(),
  validate,
  retentionWindowMs: 14 * 24 * 60 * 60 * 1000, // 2 weeks
})

// 3. Try to move a 4th task to "doing"
// If another user already filled the slot, this operation
// will be REJECTED on all clients (including this one).
log.emit([
  { kind: "set", path: ["tasks", 3], key: "status", value: "doing" }
])
```

## Features

- 🛡️ **Bulletproof Validation**: Define a single `(state) => boolean` function. If it returns false, the transaction never happened.
- ⏭️ **Replayable History**: Since it's an event log, you can replay history to see exactly *how* a state was reached (up to the nearest checkpoint).
- 🏎️ **Optimistic UI**: Changes apply instantly locally. If they are later rejected (due to a conflict with a remote peer), the state automatically rolls back.
- 📦 **Plain JSON**: Work with standard JS objects and arrays. No need to learn `ymap.get('foo')` syntax.
- 🔌 **Network Agnostic**: Works with any transport layer (WebSockets, WebRTC, etc.). Bring your own sync.
- 💾 **Storage Efficient**: Built-in checkpointing and retention policies keep your data small and fast.
- 🪶 **Minimal CRDT Overhead**: Custom set-once LWW-Map design stays close to raw JSON size.

### CRDT Size Comparison

After 100 checkpoint cycles (10,000 total set/delete operations), with only the final checkpoint remaining:

| Library | Encoded Size | Overhead vs JSON |
| :--- | ---: | ---: |
| *JSON baseline* | *~16 KB* | *1×* |
| **state-sync-log** | **~16 KB** | **~1%** |
| Yjs | ~305 KB | ~20× |
| json-joy | ~348 KB | ~22× |
| Automerge | ~517 KB | ~33× |
| Loro | ~874 KB | ~56× |

> **Note:** This benchmark simulates a realistic state-sync-log workload: 100 transactions → checkpoint → delete all transactions, repeated 100 times. Results may vary based on your specific use case.

## Contents

- [Installation](#installation)
- [API Reference](#api-reference)
- [Operations](#operations)
- [Generating Operations with createOps](#generating-operations-with-createops)
- [Integration with MobX, Signals, etc](#integration-with-mobx-signals-etc)
- [Storage Efficiency (Advanced)](#storage-efficiency-advanced)
- [Gotchas & Limitations](#gotchas--limitations)
- [Contributing](#contributing)
- [License](#license)

## Installation

```bash
npm install state-sync-log
# or
pnpm add state-sync-log
# or
yarn add state-sync-log
```

## Integration with MobX, Signals, etc

You don't have to replace your existing state manager. `state-sync-log` is designed to drive them.

Using `applyOps`, you can surgically apply updates to **MobX**, **Preact Signals**, or any mutable store:

```ts
import { applyOps } from "state-sync-log"
import { observable } from "mobx"

// 1. Create your mutable MobX store (init with current state)
const store = observable(log.getState())

// 2. Sync it!
log.subscribe((newState, getAppliedOps) => {
  // getAppliedOps is a lazy getter (computing reconciliation diffs only when requested)
  const appliedOps = getAppliedOps()

  // Apply ONLY the changes (efficient!)
  applyOps(appliedOps, store)
})
```

By default, `applyOps` deep clones values before inserting them to prevent aliasing. For better performance, you can disable cloning if you guarantee op values won't be mutated:

```ts
// Calculate ops first
const appliedOps = getAppliedOps()
applyOps(appliedOps, store, { cloneValues: false })
```

## API Reference

### `createStateSyncLog(options)`

Initializes the synchronization log.

```ts
import { createStateSyncLog, SyncLogDoc } from "state-sync-log"

const log = createStateSyncLog<State>({
  syncLogDoc: new SyncLogDoc(),
  validate: (state) => state.inventory >= 0
})
```

**Options:**

| Option | Type | Description |
| --- | --- | --- |
| `syncLogDoc` | `SyncLogDoc` | **Required.** The SyncLogDoc CRDT instance. |
| `validate` | `(state: State) => boolean` | Optional gatekeeper function. If it returns `false`, the transaction is dropped. |
| `clientId` | `string` | Optional unique ID. Auto-generated if omitted. |
| `retentionWindowMs` | `number` | **Required.** Time to keep transaction history before pruning (recommended: 2 weeks). Helps keep storage small. Use `undefined` to disable pruning. |

### `StateSyncLogController`

The object returned by `createStateSyncLog`.

#### `getState(): State`

Returns the current, validated state. Uses structural sharing for efficient immutable updates.

#### `emit(ops: Op[]): void`

Propose a change. The change applies optimistically but may be reverted if it conflicts with a remote change that renders it invalid.

#### `subscribe(callback): UnsubscribeFn`

Listen for state changes. The callback receives the new state and a lazy getter function for the operations applied.

```ts
log.subscribe((newState, getAppliedOps) => {
  const appliedOps = getAppliedOps()
  render(newState)
})
```

#### `reconcileState(targetState: State): void`

Automatically calculates the operations needed to turn the current state into `targetState` and emits them. Great for "Reset to Default" features.

#### `createCheckpoint()` / `addCheckpoint()`

For checkpointing. See [Storage Efficiency (Advanced)](#storage-efficiency-advanced).

#### `dispose(): void`

Stop listening and cleanup.

## Operations

These are the atomic building blocks of your transactions.

### `set` (Objects)

Sets a property on an object.

```ts
{ kind: "set", path: ["users", "u1"], key: "name", value: "Alice" }
```

### `delete` (Objects)

Removes a property (equivalent of setting a property to `undefined`).

```ts
{ kind: "delete", path: ["users", "u1"], key: "avatarUrl" }
```

### `splice` (Arrays)

Insert, remove, or replace items in an array.

```ts
// Remove 1 item at index 0, insert "New Item"
{ kind: "splice", path: ["todoList"], index: 0, deleteCount: 1, inserts: ["New Item"] }
```

### `addToSet` (Arrays)

Adds an item only if it doesn't exist (like a Set).

```ts
{ kind: "addToSet", path: ["tags"], value: "urgent" }
```

### `deleteFromSet` (Arrays)

Removes an item if it exists.

```ts
{ kind: "deleteFromSet", path: ["tags"], value: "deprecated" }
```

## Generating Operations with `createOps`

Writing operations by hand can be tedious and error-prone. The `createOps` utility lets you describe changes using familiar mutable-style JavaScript code, and it automatically generates the corresponding operations.

### Basic Usage

```ts
import { createOps } from "state-sync-log/createOps"

const state = { list: [{ text: "Learn", done: false }] }

const { nextState, ops } = createOps(state, (draft) => {
  // Mutate the draft like you would a normal object
  draft.list[0].done = true
  draft.list.push({ text: "Practice", done: false })
})

// ops contains the operations that were performed:
// [
//   { kind: 'set', path: ['list', 0], key: 'done', value: true },
//   { kind: 'splice', path: ['list'], index: 1, deleteCount: 0, inserts: [{ text: 'Practice', done: false }] }
// ]

// nextState is the new immutable state (original state is unchanged)
```

### Supported Mutations

- **Object properties**: `draft.user.name = "Alice"` generates a `set` op
- **Delete properties**: `delete draft.user.avatar` generates a `delete` op
- **Array methods**: `push`, `pop`, `shift`, `unshift`, `splice`, `fill`, `sort`, `reverse`, `copyWithin` all generate `splice` ops
- **Array index assignment**: `draft.list[0] = newItem` generates a `set` op
- **Array length**: `draft.list.length = 5` generates a `set` op for length

### Utility Functions

#### `original(draft)`

Returns the original (unmodified) value from a draft. Useful for comparisons.

```ts
import { createOps, original } from "state-sync-log/createOps"

createOps(state, (draft) => {
  if (original(draft.user) !== draft.user) {
    console.log("User was modified")
  }
})
```

#### `current(draft)`

Returns a snapshot of the current state of the draft (deep clone).

```ts
import { createOps, current } from "state-sync-log/createOps"

createOps(state, (draft) => {
  draft.count++
  console.log(current(draft)) // { count: 1 }
})
```

#### `isDraft(value)` / `isDraftable(value)`

Check if a value is a draft or can be made into one.

```ts
import { isDraft, isDraftable } from "state-sync-log/createOps"

isDraft(someDraft) // true for draft proxies
isDraftable({ a: 1 }) // true for plain objects/arrays
isDraftable(new Date()) // false for class instances
```

#### `addToSet(draft, path, value)` / `deleteFromSet(draft, path, value)`

Helpers for treating arrays as sets (no duplicates).

```ts
import { createOps, addToSet, deleteFromSet } from "state-sync-log/createOps"

const { ops } = createOps({ tags: ["a", "b"] }, (draft) => {
  addToSet(draft, ["tags"], "c") // Adds "c" since it doesn't exist
  addToSet(draft, ["tags"], "a") // No-op, "a" already exists
  deleteFromSet(draft, ["tags"], "b") // Removes "b"
})
// ops: [{ kind: 'addToSet', ... }, { kind: 'deleteFromSet', ... }]
```

## Storage Efficiency (Advanced)

Since this is an append-only log, you might worry about it growing forever. We solved that.

### 🗜️ Checkpointing & Retention

`state-sync-log` can periodically checkpoint the log into a **snapshot checkpoint**.

- **Checkpoints:** New peers just load the latest snapshot + recent ops. Fast load times!
- **Retention Window:** Old transaction history is automatically pruned after a set time (recommended: 2 weeks).
- **Result:** You get a full audit trail for recent history, without unboundedly growing storage.

### Why Coordinated Checkpointing?

When two clients checkpoint independently while offline, data can be lost:

1. Client A creates Checkpoint_A with only A's transactions
2. Client B creates Checkpoint_B with only B's transactions
3. On sync, one checkpoint "wins" based on transaction count
4. The losing client's transactions are lost

**The solution:** Checkpointing must be coordinated so that all clients share the same checkpoint.

> **Note:** It's fine if a checkpoint is created while some clients are offline. When an offline client reconnects and syncs, its changes are automatically rebased on top of the checkpoint. The CRDT layer handles this seamlessly.

### Option 1: Server-Mediated Checkpointing

The server coordinates checkpointing by asking a connected client to create a checkpoint, then broadcasting it to all connected clients.

**Pros:** Server doesn't need to maintain the document state in memory.
**Cons:** Requires coordination protocol between server and clients.

```ts
// Server-side (pseudo-code)
async function handleCheckpointing() {
  // 1. Pick a connected client to create the checkpoint
  const client = pickConnectedClient()

  // 2. Ask client to create checkpoint
  const checkpoint = await client.requestCheckpoint()

  // 3. Broadcast to ALL connected clients
  for (const c of connectedClients) {
    c.sendCheckpoint(checkpoint)
  }
}

// Client-side
// On server request:
const checkpoint = log.createCheckpoint()
sendToServer(checkpoint)

// On receiving checkpoint from server:
log.addCheckpoint(checkpoint)
```

### Option 2: Server as a Client

The server maintains its own `StateSyncLog` instance and performs checkpointing directly.

**Pros:** Simpler implementation—server controls checkpointing timing.
**Cons:** Server requires RAM/CPU to maintain the document state.

```ts
// Server-side
const serverDoc = new SyncLogDoc()
const serverLog = createStateSyncLog<State>({
  syncLogDoc: serverDoc,
  clientId: "server",
  retentionWindowMs: 14 * 24 * 60 * 60 * 1000,
})

// Server syncs with clients via serverDoc.encodeStateAsUpdate() / applyUpdate()

// Server triggers checkpointing directly
function checkpointOnServer() {
  const checkpoint = serverLog.createCheckpoint()
  if (checkpoint) {
    serverLog.addCheckpoint(checkpoint)
    // Checkpoint is synced to clients via normal CRDT sync
  }
}
```

### Checkpointing API

#### `createCheckpoint(): CheckpointData | null`

Creates a checkpoint without persisting it. Returns `null` if the current epoch has no transactions.

#### `addCheckpoint(checkpoint: CheckpointData): void`

Persists a checkpoint. This prunes covered transactions and advances the epoch.

### Monitoring Statistics

You can monitor the current epoch's statistics to help decide when to trigger checkpointing:

```ts
const opsInEpoch = log.getActiveEpochOpsCount()
const txsInEpoch = log.getActiveEpochTxCount()
const lastCheckpointTime = log.getLastCheckpointTime()
```

## Gotchas & Limitations

1. **Validation must be deterministic:** Your `validate` function must return the same result for the same state input (deterministic). Don't check `Date.now()` or make API calls inside it.
2. **Not for Text:** Do not use this for collaborative text editing (Google Docs style). Use a dedicated text CRDT library like Y.js for that use case.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
