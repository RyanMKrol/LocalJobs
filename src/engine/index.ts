// The workflow engine's public surface: everything a workflow needs in order to
// define its stages. Workflows import from here (`'../../../engine/index.js'`),
// not from the engine's internal files, so those can change freely.
//
// What the engine is: a DAG of stages with declared inputs and outputs (ports).
// It binds them at load, runs stages in dependency order with bounded
// parallelism, hands each stage what its producers committed in the same run,
// checks and records every output, retries, cancels, and keeps a per-run record
// from which the dashboard's run page is derived.
//
// What it is NOT: it knows nothing about any particular workflow, service, API
// or notifier. The application connects itself through `configureEngine`
// (see host.ts). `boundary.test.ts` enforces that no engine file imports outward.

// Defining stages and the data they exchange.
export {
  acceptAny,
  defineStage,
  dirArtifact,
  dirFilePaths,
  fileArtifact,
  fromChecks,
  inlineArtifact,
  jsonArtifact,
  ledgerArtifact,
} from './ports.js';
export type {
  ArtifactMeta,
  ArtifactStorage,
  ArtifactType,
  DirListing,
  FileInfo,
  InputHandle,
  InputPort,
  IoItem,
  LedgerRowValue,
  OutputHandle,
  OutputPort,
  RunIdentity,
  StageContext,
  StageDefinition,
  StateDecl,
} from './ports.js';

// The core types: jobs, workflows, runs, gate results.
export type * from './types.js';

// Helpers for writing a stage's data safely.
export { createCheckpoint } from './checkpoint.js';
export type { Checkpoint } from './checkpoint.js';
export { ensureDirs, readJsonFile, writeFileAtomic, writeJsonFile } from './fsjson.js';

// Connecting an application to the engine, and running workflows.
export { configureEngine } from './host.js';
export type { EngineHost } from './host.js';
export { cancelWorkflowRun, runWorkflow, workflowRunInProgress } from './workflow-executor.js';
