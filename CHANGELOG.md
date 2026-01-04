# Changelog

## 0.11.0

- **Breaking:** Replaced `compact()` and `autoCompact` option with `createCheckpoint()` and `addCheckpoint()` for server-mediated checkpointing.
  - `createCheckpoint()`: Creates checkpoint data without persisting it (returns `CheckpointData | null`).
  - `addCheckpoint(checkpoint)`: Persists a checkpoint received from the server.
  - Removed `autoCompact` option and `defaultAutoCompact` export.
  - Removed `AutoCompactParams` type export.
- **Breaking:** Renamed `getLastCompactionTime()` to `getLastCheckpointTime()`.
- Added `CheckpointData` type export.
- This change prevents data loss when offline clients checkpoint independently. The server now coordinates checkpointing by asking a connected client to create a checkpoint, then broadcasting it to all clients.

## 0.10.0

- Lots of fixes, changes and improvements
- Added `createOps` API to be able to generate operations from a state mutation.

## 0.9.0

- Initial release
