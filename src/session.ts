/**
 * Shared AVA session management and result shaping for the AI SDK tools.
 *
 * One AVA instance is created lazily and kept per tool set. Loading a new source
 * replaces the previous dataset, so the tools stay cheap to call and the agent
 * never has to pass a dataset id around.
 */

import { createRequire } from 'node:module';

import type { AnalysisResponse, ChartSpec, DataSourceConfig, ExecutionResult, LLMConfig, Profile, Schema, AVA as AVAType } from '@antv/ava';

/**
 * AVA ships a CommonJS build, but its `esm/` output keeps extensionless
 * directory imports, so `import '@antv/ava'` fails under Node ESM with
 * ERR_UNSUPPORTED_DIR_IMPORT. Loading the CommonJS entry through
 * `createRequire` works from both module systems on Node 22+.
 */
const require = createRequire(import.meta.url);
const avaModule = require('@antv/ava') as typeof import('@antv/ava');

export const DEFAULT_MAX_ROWS = 200;
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Configuration shared by every tool in the set. */
export interface AVAToolsConfig {
  /**
   * Provider settings for natural-language analysis, chart recommendation,
   * and question suggestions. When omitted, the tools read
   * `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL` from the
   * environment, matching the AVA CLI.
   */
  llm?: LLMConfig;
  /** Engine used for loaded data. Defaults to DuckDB. */
  engine?: 'duckdb' | 'python' | 'javascript';
  /** Hard cap on rows a single `query` or `analyze` call can return. Default 200. */
  maxRows?: number;
  /** Abort a single tool call after this many milliseconds. Default 60000. */
  timeoutMs?: number;
}

/** Rows, schema, and bounded-size flags returned to the model. */
export interface TableResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  truncatedBy?: 'maxRows' | 'maxResultBytes';
}

/**
 * Resolve the LLM config from explicit settings, then the environment used by
 * the AVA CLI. Returns `undefined` when no key is configured so deterministic
 * tools keep working without a model.
 */
export function resolveLLMConfig(config: AVAToolsConfig = {}): LLMConfig | undefined {
  if (config.llm) return config.llm;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;

  return {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  };
}

/**
 * Convert an AVA execution result into a compact, model-friendly shape.
 * Drops column metadata noise while keeping type information the model can use.
 */
export function toTableResult(result: ExecutionResult, maxRows: number): TableResult {
  const rows = result.data.slice(0, maxRows);
  return {
    columns: result.schema.map((column) => ({ name: column.name, type: column.type ?? 'UNKNOWN' })),
    rows,
    ...(result.rowCount === undefined ? {} : { rowCount: result.rowCount }),
    ...(result.truncated || result.data.length > maxRows ? { truncated: true, truncatedBy: 'maxRows' as const } : {}),
  };
}

/** Strip the HTML payload from a chart so tool output stays small. */
export function toChartSummary(spec: ChartSpec) {
  return { chartType: spec.chartType, config: spec.config };
}

/**
 * Owns one AVA instance and the dataset loaded into it.
 *
 * `dispose()` is idempotent and must be called when the surrounding agent stops
 * using the tools, otherwise the DuckDB connection stays open for the process
 * lifetime.
 */
export class AVASession {
  private readonly config: AVAToolsConfig;
  private ava: AVAType | null = null;
  private loaded: DataSourceConfig | null = null;

  constructor(config: AVAToolsConfig = {}) {
    this.config = config;
  }

  /** Whether a dataset has been loaded and is ready for queries. */
  get hasDataset(): boolean {
    return this.loaded !== null;
  }

  /** Description of the currently loaded source, for tool errors and status. */
  get loadedSource(): DataSourceConfig | null {
    return this.loaded;
  }

  /** Lazily create the AVA instance with the configured model. */
  private instance(): AVAType {
    if (this.ava) return this.ava;

    const llm = resolveLLMConfig(this.config);
    this.ava = new avaModule.AVA({
      llm: llm ?? { model: 'gpt-4o-mini', apiKey: 'not-configured' },
      engine: { type: this.config.engine ?? 'duckdb' },
    });
    return this.ava;
  }

  /** Load (or replace) the dataset the tools operate on. */
  async load(source: DataSourceConfig): Promise<Schema> {
    const ava = this.instance();
    await ava.source(source);
    this.loaded = source;
    return ava.schema();
  }

  /** Describe the loaded dataset. */
  async schema(): Promise<Schema> {
    return this.require().schema();
  }

  /** Compute column statistics. Omit `metrics` for AVA's default set. */
  async profile(metrics?: string[]): Promise<Profile> {
    return this.require().profile(metrics?.length ? { metrics } : {});
  }

  /** Execute one read-only SQL statement. */
  async query(sql: string): Promise<ExecutionResult> {
    return this.guard(this.require().query(sql, { maxRows: this.config.maxRows ?? DEFAULT_MAX_ROWS }));
  }

  /** Translate a question to SQL and execute it, optionally summarizing. */
  async analyze(question: string, includeSummary = true): Promise<AnalysisResponse> {
    return this.guard(
      this.require().analyze(question, {
        maxRows: this.config.maxRows ?? DEFAULT_MAX_ROWS,
        includeSummary,
      })
    );
  }

  /** Translate a question to SQL without executing it. */
  async translate(question: string): Promise<string> {
    return this.guard(this.require().translate(question));
  }

  /** Recommend a chart specification for a result. */
  async recommend(result: Pick<AnalysisResponse, 'query' | 'data'>): Promise<ChartSpec | null> {
    return this.guard(this.require().recommend(result));
  }

  /** Suggest questions about the loaded dataset. */
  async suggest(count: number): Promise<{ query: string; score: number; reason: string }[]> {
    return this.guard(this.require().suggest(count));
  }

  /** Release the engine and forget the dataset. Safe to call repeatedly. */
  async dispose(): Promise<void> {
    const ava = this.ava;
    this.ava = null;
    this.loaded = null;
    if (ava) await ava.dispose();
  }

  private require(): AVAType {
    if (!this.loaded) {
      throw new Error('No dataset loaded. Call the ava_load_data tool first with a CSV, JSON, or text source.');
    }
    return this.instance();
  }

  /**
   * Bound a model-facing call with `timeoutMs` so a stalled provider cannot
   * hang the agent loop forever. AVA v4 has no abort signal of its own, so the
   * race rejects and lets the loop continue; the engine keeps the work in the
   * background and a later `dispose()` cleans it up.
   */
  private async guard<T>(work: Promise<T>): Promise<T> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`AVA did not respond within ${timeoutMs}ms. Check the model provider and retry.`)),
        timeoutMs
      );
      // Never keep the host process alive just for the timer.
      (timer as { unref?: () => void }).unref?.();
    });

    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
