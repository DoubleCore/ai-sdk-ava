/**
 * AVA tools for the Vercel AI SDK.
 *
 * The agent loads a dataset, inspects its schema, writes SQL, and asks AVA to
 * turn verified rows into a chart. AVA owns data access and rendering; the
 * agent owns the reasoning.
 */

import { tool } from 'ai';
import { z } from 'zod';

import { AVASession, toChartSummary, toTableResult } from './session.js';

import type { AVAToolsConfig } from './session.js';
import type { DataSourceConfig, Schema } from '@antv/ava';

const csvSource = z.object({
  type: z.literal('csv'),
  csv: z.string().min(1).describe('Raw CSV text, including the header row.'),
});

const jsonSource = z.object({
  type: z.literal('json'),
  data: z.array(z.record(z.string(), z.unknown())).min(1).describe('Array of row objects.'),
});

const textSource = z.object({
  type: z.literal('text'),
  text: z.string().min(1).describe('Unstructured text for AVA to interpret. Requires a model.'),
});

const fileSource = z.object({
  type: z.enum(['csv-file', 'json-file', 'parquet', 'excel']),
  path: z.string().min(1).describe('Absolute path or http(s) URL readable by the host.'),
});

const sourceSchema = z.discriminatedUnion('type', [csvSource, jsonSource, textSource, fileSource]);

type SourceInput = z.infer<typeof sourceSchema>;

/** Map the tool input onto AVA's discriminated source config. */
function toSourceConfig(source: SourceInput): DataSourceConfig {
  switch (source.type) {
    case 'csv':
      return { type: 'csv', options: { csv: source.csv } };
    case 'json':
      return { type: 'json', options: { data: source.data } };
    case 'text':
      return { type: 'text', options: { text: source.text } };
    default:
      return { type: source.type, options: { path: source.path } } as DataSourceConfig;
  }
}

/** Compact schema shape sent to the model. */
function toSchemaResult(schema: Schema) {
  return {
    tables: schema.models.map((model: Schema['models'][number]) => ({
      name: model.name,
      columns: model.columns.map((column: Schema['models'][number]['columns'][number]) => ({
        name: column.name,
        type: column.type ?? 'UNKNOWN',
      })),
    })),
    relationships: schema.relationships ?? [],
  };
}

/** Build the tool set. Call the returned `dispose()` when the agent stops using it. */
export function avaTools(config: AVAToolsConfig = {}) {
  const session = new AVASession(config);
  const maxRows = config.maxRows ?? 200;

  const tools = {
    ava_load_data: tool({
      description:
        'Load a dataset into AVA and return its schema. Replaces any previously loaded dataset. ' +
        'Use inline CSV or JSON for small data the user pasted; use a file path for larger local files.',
      inputSchema: z.object({
        source: sourceSchema.describe('The dataset to load.'),
      }),
      execute: async (input: { source: SourceInput }) => toSchemaResult(await session.load(toSourceConfig(input.source))),
    }),

    ava_schema: tool({
      description: 'Return the schema of the loaded dataset: table names, columns, and types.',
      inputSchema: z.object({}),
      execute: async () => toSchemaResult(await session.schema()),
    }),

    ava_profile: tool({
      description:
        'Compute column statistics (row count, nulls, distinct, min, max, mean, median) for the loaded dataset. ' +
        'Use it before analysis to check data quality or value ranges.',
      inputSchema: z.object({
        metrics: z
          .array(z.enum(['row_count', 'null_count', 'distinct_count', 'min', 'max', 'mean', 'median']))
          .optional()
          .describe('Statistics to compute. Omit for AVA defaults.'),
      }),
      execute: async ({ metrics }: { metrics?: string[] }) => {
        const profile = await session.profile(metrics);
        if (!metrics?.length) return profile;

        // AVA reports table metrics (row_count) and column metrics separately;
        // trim both to the requested set so the model sees only what it asked for.
        const keep = new Set(metrics);
        const trim = (bag?: Record<string, unknown>) =>
          Object.fromEntries(Object.entries(bag ?? {}).filter(([name]) => keep.has(name)));
        return {
          ...profile,
          models: profile.models.map((model) => ({
            ...model,
            metrics: trim(model.metrics as Record<string, unknown> | undefined),
            columns: model.columns.map((column) => ({
              ...column,
              metrics: trim(column.metrics as Record<string, unknown> | undefined),
            })),
          })),
        };
      },
    }),

    ava_query: tool({
      description:
        'Execute one read-only SQL statement against the loaded dataset with DuckDB semantics. ' +
        'Aggregate, filter, and sort in SQL so you analyze a small result instead of raw rows.',
      inputSchema: z.object({
        sql: z.string().min(1).describe('A single SELECT statement. Reference the table name from ava_schema.'),
      }),
      execute: async ({ sql }: { sql: string }) => toTableResult(await session.query(sql), maxRows),
    }),

    ava_analyze: tool({
      description:
        'Ask a natural-language question about the loaded dataset. AVA writes the SQL, executes it, and ' +
        'summarizes the result. Requires a configured model.',
      inputSchema: z.object({
        question: z.string().min(1).describe('The question to answer from the data.'),
        includeSummary: z
          .boolean()
          .optional()
          .describe('Whether AVA should write a prose answer. Defaults to true.'),
      }),
      execute: async ({ question, includeSummary }: { question: string; includeSummary?: boolean }) => {
        const result = await session.analyze(question, includeSummary ?? true);
        return {
          ...toTableResult(result, maxRows),
          query: result.query,
          ...(result.sql ? { sql: result.sql } : {}),
          text: result.text,
          ...(result.markdown ? { markdown: result.markdown } : {}),
        };
      },
    }),

    ava_translate: tool({
      description: 'Translate a natural-language question into SQL without executing it, so the user can review it.',
      inputSchema: z.object({
        question: z.string().min(1).describe('The question to translate into SQL.'),
      }),
      execute: async ({ question }: { question: string }) => ({ sql: await session.translate(question) }),
    }),

    ava_suggest: tool({
      description: 'Suggest useful questions about the loaded dataset, for when the user has data but no question.',
      inputSchema: z.object({
        count: z.number().int().min(1).max(10).optional().describe('How many questions to suggest. Defaults to 3.'),
      }),
      execute: async ({ count }: { count?: number }) => ({ suggestions: await session.suggest(count ?? 3) }),
    }),

    ava_visualize: tool({
      description:
        'Recommend a chart for a query result. Pass rows from ava_query or ava_analyze and the question they ' +
        'answer. Returns GPT-Vis JSON that `renderChart` turns into standalone HTML.',
      inputSchema: z.object({
        question: z.string().min(1).describe('The question the rows answer.'),
        data: z.array(z.record(z.string(), z.unknown())).min(1).describe('Rows from a previous tool call.'),
      }),
      execute: async ({ question, data }: { question: string; data: Record<string, unknown>[] }) => {
        const spec = await session.recommend({ query: question, data });
        return spec ? toChartSummary(spec) : { chartType: null, message: 'The data does not need a chart.' };
      },
    }),
  };

  return { tools, session, dispose: () => session.dispose() };
}

export { renderChart } from './render.js';
export { AVASession, resolveLLMConfig, toTableResult, toChartSummary } from './session.js';
export type { AVAToolsConfig, TableResult } from './session.js';
