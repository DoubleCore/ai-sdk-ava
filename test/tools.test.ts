import { describe, expect, it, afterEach } from 'vitest';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

import { avaTools, renderChart, toTableResult } from '../src/index.js';

import type { AVASession } from '../src/index.js';
import type { ChartSpec, Profile } from '@antv/ava';

const CSV = 'region,product,sales\nEast,Laptop,3\nWest,Laptop,7\nNorth,Monitor,5\nWest,Monitor,6\n';

const exampleCsv = new URL('../examples/sales.csv', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Minimal V3 usage/finish-reason shapes the AI SDK requires — not just loose strings. */
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
  totalTokens: { total: 15 },
};

/**
 * Execute a tool directly. The AI SDK fills `ToolExecutionOptions` at runtime,
 * so tests only pass the pieces AVA reads. The v7 result type is
 * `T | AsyncIterable<T>`; the cast keeps assertions readable.
 */
function run<T>(tool: { execute?: unknown }, input: unknown): Promise<T> {
  return (tool.execute as (input: unknown, options: unknown) => Promise<T>)(input, {
    toolCallId: 'test',
    messages: [],
    context: {},
  });
}

/** A model that always returns the same text — used for SQL translation. */
function sqlModel(sql: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: sql }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage,
      warnings: [],
    }),
  });
}

/** A model that calls one tool per step, then answers with prose. */
function loopModel(steps: { toolName: string; input: Record<string, unknown> }[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[index++];
      if (!step) {
        return {
          content: [{ type: 'text' as const, text: 'West sells the most.' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: `call-${index}`,
            toolName: step.toolName,
            input: JSON.stringify(step.input),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
        usage,
        warnings: [],
      };
    },
  });
}

describe('avaTools wiring', () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it('exposes one tool per AVA capability with stable names', () => {
    const { tools, dispose: stop } = avaTools();
    dispose = stop;
    expect(Object.keys(tools).sort()).toEqual([
      'ava_analyze',
      'ava_load_data',
      'ava_profile',
      'ava_query',
      'ava_schema',
      'ava_suggest',
      'ava_translate',
      'ava_visualize',
    ]);
    for (const current of Object.values(tools)) {
      expect(current.description).toBeTruthy();
    }
  });

  it('loads inline CSV and returns the discovered schema', async () => {
    const { tools, dispose: stop } = avaTools();
    dispose = stop;

    const loaded = await run<{ tables: { name: string; columns: { name: string; type: string }[] }[] }>(
      tools.ava_load_data,
      { source: { type: 'csv', csv: CSV } }
    );

    expect(loaded).toMatchObject({
      tables: [
        {
          name: 'data',
          columns: [
            { name: 'region', type: 'VARCHAR' },
            { name: 'product', type: 'VARCHAR' },
            { name: 'sales', type: 'BIGINT' },
          ],
        },
      ],
    });
  });

  it('loads a CSV file from disk', async () => {
    const { tools, dispose: stop } = avaTools();
    dispose = stop;

    const loaded = await run<{ tables: { columns: { name: string }[] }[] }>(tools.ava_load_data, {
      source: { type: 'csv-file', path: exampleCsv },
    });

    expect(loaded.tables[0].columns.map((column) => column.name)).toContain('quarter');
  });

  it('rejects querying before data is loaded, then runs SQL after load', async () => {
    const { tools, dispose: stop } = avaTools();
    dispose = stop;

    await expect(run(tools.ava_query, { sql: 'SELECT 1' })).rejects.toThrow(/No dataset loaded/);

    await run(tools.ava_load_data, { source: { type: 'csv', csv: CSV } });

    const result = await run(tools.ava_query, {
      sql: 'SELECT region, SUM(sales) AS total FROM data GROUP BY region ORDER BY total DESC',
    });

    expect(result).toEqual({
      columns: [
        { name: 'region', type: 'VARCHAR' },
        { name: 'total', type: 'HUGEINT' },
      ],
      rows: [
        { region: 'West', total: 13 },
        { region: 'North', total: 5 },
        { region: 'East', total: 3 },
      ],
      rowCount: 3,
    });
  });

  it('caps rows at maxRows and flags truncation', async () => {
    const { tools, dispose: stop } = avaTools({ maxRows: 2 });
    dispose = stop;
    await run(tools.ava_load_data, { source: { type: 'csv', csv: CSV } });

    const result = await run<{ rows: unknown[]; truncated?: boolean }>(tools.ava_query, { sql: 'SELECT * FROM data' });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(toTableResult({ schema: [], data: [], rowCount: 0 }, 2)).toEqual({
      columns: [],
      rows: [],
      rowCount: 0,
    });
  });

  it('analyzes a natural-language question through the model', async () => {
    const { tools, dispose: stop } = avaTools({
      llm: { model: sqlModel('SELECT region, sales FROM data ORDER BY sales DESC LIMIT 1') },
    });
    dispose = stop;
    await run(tools.ava_load_data, { source: { type: 'csv', csv: CSV } });

    const result = await run<{ rows: unknown[]; sql?: string; text: string }>(tools.ava_analyze, {
      question: 'Which row has the highest sales?',
      includeSummary: false,
    });

    expect(result.rows).toEqual([{ region: 'West', sales: 7 }]);
    expect(result.sql).toContain('ORDER BY sales DESC');
    expect(result.text).toBe('');
  });

  it('translates without executing', async () => {
    const { tools, dispose: stop } = avaTools({
      llm: { model: sqlModel('SELECT SUM(sales) AS total FROM data') },
    });
    dispose = stop;
    await run(tools.ava_load_data, { source: { type: 'csv', csv: CSV } });
    await expect(run(tools.ava_translate, { question: 'Total sales' })).resolves.toEqual({
      sql: 'SELECT SUM(sales) AS total FROM data',
    });
  });

  it('profiles the loaded dataset and filters metrics', async () => {
    const { tools, dispose: stop } = avaTools();
    dispose = stop;
    await run(tools.ava_load_data, { source: { type: 'csv', csv: CSV } });

    const profile = await run<Profile>(tools.ava_profile, { metrics: ['row_count'] });
    expect(profile.models[0].metrics).toEqual({ row_count: 4 });
    const sales = profile.models[0].columns.find((column: { name: string }) => column.name === 'sales');
    expect(sales?.metrics).toEqual({});
  });

  it('drives a real tool loop from generateText', async () => {
    const model = loopModel([
      { toolName: 'ava_load_data', input: { source: { type: 'csv', csv: CSV } } },
      {
        toolName: 'ava_query',
        input: { sql: 'SELECT region, SUM(sales) AS total FROM data GROUP BY region ORDER BY total DESC' },
      },
    ]);
    const { tools, dispose: stop } = avaTools();
    dispose = stop;

    const result = await generateText({
      model,
      tools,
      stopWhen: stepCountIs(4),
      prompt: 'Which region sells the most?',
    });

    expect(result.text).toBe('West sells the most.');
    expect(result.steps).toHaveLength(3);
    const toolNames = result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
    expect(toolNames).toEqual(['ava_load_data', 'ava_query']);
    const queryResult = result.steps[1].toolResults[0].output as {
      rows: { region: string; total: number }[];
    };
    expect(queryResult.rows[0]).toEqual({ region: 'West', total: 13 });
  });

  it('fails fast when a model call exceeds timeoutMs', async () => {
    const { tools, dispose: stop } = avaTools({
      llm: { model: new MockLanguageModelV3({ doGenerate: () => new Promise(() => {}) }) },
      timeoutMs: 300,
    });
    dispose = stop;
    await run(tools.ava_load_data, { source: { type: 'csv', csv: CSV } });

    await expect(run(tools.ava_translate, { question: 'Anything' })).rejects.toThrow(/did not respond within 300ms/);
  });

  it('keeps the session usable after a tool error', async () => {
    const { tools, session, dispose: stop } = avaTools();
    dispose = stop;
    await run(tools.ava_load_data, { source: { type: 'csv', csv: CSV } });

    await expect(run(tools.ava_query, { sql: 'DELETE FROM data' })).rejects.toThrow(/read-only|delete/i);
    expect((session as AVASession).hasDataset).toBe(true);
    const schema = await run<{ tables: unknown[] }>(tools.ava_schema, {});
    expect(schema.tables).toHaveLength(1);
  });
});

describe('renderChart', () => {
  it('renders a chart config to HTML without a model call', async () => {
    const spec: ChartSpec = {
      chartType: 'column',
      config: { type: 'column', data: [{ region: 'West', total: 13 }], xField: 'region', yField: 'total' },
    };
    const result = await renderChart(spec);
    expect(result.chartType).toBe('column');
    expect(result.html).toContain('<html');
    expect(result.html).toContain('gpt-vis');
  });
});
