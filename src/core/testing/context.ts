// A StageContext for unit tests: lets a test call a ports stage's `run()` with
// inputs it supplies and see what the stage committed, with no workflow run, no
// child process and no database.
import { writeJsonFile } from '../fsjson.js';
import { outputLocation } from '../ports.js';
import type { ArtifactMeta, InputHandle, IoItem, OutputHandle, StageContext } from '../ports.js';
import type { GateResult, JobDefinition, LogLevel } from '../types.js';

/** One input given to a test context: a location to read from, or the value itself. */
export type TestInput = { location: string; from?: string } | { value: unknown; from?: string };

export interface TestOutputRecord {
  /** How the stage committed it. */
  via: 'write' | 'commit' | 'unchanged';
  /** The value given to write(), or loaded from the location on commit()/unchanged(). */
  value: unknown;
  check: GateResult;
  /** The reason given to unchanged(). */
  note?: string;
}

export interface TestContext {
  ctx: StageContext;
  /** What the stage committed, by output port. */
  outputs: Record<string, TestOutputRecord>;
  /** What the stage reported via `input.used()`, by input port. */
  used: Record<string, IoItem[]>;
  logs: { level: LogLevel; message: string }[];
}

/**
 * Build a test context for `def`. `inputs` maps each input port to what it should
 * receive (an array for a fan-in port). Outputs behave like the real thing: a
 * failed check throws, a JSON `write` lands on disk when the port has a location.
 */
export function makeTestContext(
  def: JobDefinition,
  opts: {
    inputs?: Record<string, TestInput | TestInput[]>;
    selectedRoots?: ReadonlySet<string> | null;
    run?: Partial<StageContext['run']>;
  } = {},
): TestContext {
  const outputs: Record<string, TestOutputRecord> = {};
  const used: Record<string, IoItem[]> = {};
  const logs: { level: LogLevel; message: string }[] = [];
  const roots = opts.selectedRoots ?? null;

  const handles = (port: string): InputHandle[] => {
    const decl = def.inputs?.[port];
    if (!decl) throw new Error(`stage "${def.name}" has no input port "${port}"`);
    const given = opts.inputs?.[port];
    if (given === undefined) throw new Error(`test context for "${def.name}" was given no input "${port}"`);
    return (Array.isArray(given) ? given : [given]).map((g, i) => {
      const location = 'location' in g ? g.location : '';
      const meta: ArtifactMeta = { id: i + 1, producer: g.from ?? 'test', runId: 'test-run', sha256: null, bytes: null, itemCount: null, fresh: true, committedAtMs: Date.now() };
      return {
        from: g.from ?? 'test',
        location,
        path: location,
        meta,
        read: () => ('value' in g ? g.value : decl.artifact.read(location)),
        used: (items: IoItem[]) => { used[port] = items; },
      };
    });
  };

  const output = (port: string): OutputHandle => {
    const out = def.outputs?.[port];
    if (!out) throw new Error(`stage "${def.name}" has no output port "${port}"`);
    const location = out.artifact.storage === 'inline' ? '' : outputLocation(def.name, out);
    const fromLocation = (via: 'commit' | 'unchanged', note?: string): void => {
      const value = out.artifact.read(location);
      const check = out.artifact.check(value);
      outputs[port] = { via, value, check, note };
      if (!check.ok) throw new Error(`output "${port}" failed its check: ${(check.violations ?? []).join('; ')}`);
    };
    return {
      location,
      path: location,
      write(value) {
        const check = out.artifact.check(value);
        if (!check.ok) throw new Error(`output "${port}" failed its check, nothing was written: ${(check.violations ?? []).join('; ')}`);
        if (out.artifact.storage === 'json') writeJsonFile(location, value);
        outputs[port] = { via: 'write', value, check };
      },
      commit: () => fromLocation('commit'),
      unchanged: (reason) => fromLocation('unchanged', reason),
    };
  };

  const ctx = {
    log: (message: string, level: LogLevel = 'info') => { logs.push({ level, message }); },
    progress: () => {},
    selectedRoots: () => roots,
    rootAllowed: (k: string) => !roots || roots.has(k),
    run: { runId: 'test-run', workflowRunId: 'test-workflow-run', workflowName: 'test', jobName: def.name, attempt: 1, cycle: 1, trigger: 'manual', ...opts.run },
    input: (port: string) => handles(port)[0],
    inputs: (port: string) => handles(port),
    output,
  } as unknown as StageContext;

  return { ctx, outputs, used, logs };
}
