# ai-sdk-ava

[AVA](https://github.com/antvis/AVA) tools for the [Vercel AI SDK](https://sdk.vercel.ai). Give any AI SDK agent the ability to load a dataset, inspect its schema, write SQL, ask AVA a natural-language question, and turn verified rows into a chart.

AVA owns data access and rendering; your model owns the reasoning. No AVA CLI, no server process — the tools run in the same Node.js process as your agent.

## Install

```bash
npm install ai-sdk-ava @antv/ava ai zod
```

`@antv/ava` v4 and Zod ≥ 4.6.7 are peer dependencies. Requires Node.js ≥ 22.13.

## Usage

```ts
import { generateText, stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { avaTools } from 'ai-sdk-ava';

const { tools, dispose } = avaTools({
  // Optional: omit to read OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL
  llm: { model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY },
  maxRows: 200,
});

try {
  const { text } = await generateText({
    model: openai('gpt-4o-mini'),
    tools,
    stopWhen: stepCountIs(8),
    prompt: 'Load examples/sales.csv, then tell me which region sells the most and chart it.',
  });
  console.log(text);
} finally {
  await dispose(); // closes the DuckDB connection
}
```

The agent decides the order. A typical run is `ava_load_data → ava_schema → ava_query → ava_visualize`.

## Tools

| Tool | What it does | Needs a model |
| --- | --- | --- |
| `ava_load_data` | Load inline CSV/JSON/text or a file path (`.csv`, `.json`, `.parquet`, `.xlsx`). Replaces the current dataset and returns the schema. | only for `text` |
| `ava_schema` | Table names, columns, and types. | no |
| `ava_profile` | Row count, nulls, distinct, min/max/mean/median per column, filtered to the metrics you pass. | no |
| `ava_query` | One read-only SQL statement with DuckDB semantics. Results are capped at `maxRows`. | no |
| `ava_analyze` | Natural-language question → AVA writes SQL, executes it, and summarizes the answer. | yes |
| `ava_translate` | Natural-language question → SQL, without executing it, so a human can review it. | yes |
| `ava_suggest` | Suggest questions worth asking about the loaded dataset. | yes |
| `ava_visualize` | Recommend a chart for rows from a previous call; returns GPT-Vis JSON. | yes |

## Rendering charts

`ava_visualize` returns a chart spec, not HTML. Turn it into a standalone page with `renderChart` — no model call is involved:

```ts
import { renderChart } from 'ai-sdk-ava';

const { path } = await renderChart(chartSpec, { outputPath: 'chart.html' });
```

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `llm` | env vars | Falls back to `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` — the same variables the AVA CLI uses. Any OpenAI-compatible endpoint works. |
| `engine` | `'duckdb'` | Also accepts `'python'` and `'javascript'`. |
| `maxRows` | `200` | Hard cap per `query` / `analyze` result. Truncation is reported to the model. |
| `timeoutMs` | `60000` | Budget for one tool call, so a stalled provider can't hang the agent loop. |

Deterministic tools (`load_data` on CSV/JSON/file, `schema`, `profile`, `query`) work without any API key.

## Safety notes

- SQL is executed read-only; writes, DDL, and multi-statement scripts are rejected by the engine.
- Results are truncated to `maxRows` and flagged with `truncated: true`, so the model never silently reasons over a partial table.

## Development

```bash
npm install
npm run build
npm test        # vitest: tool wiring, schema, SQL, truncation, model-backed analyze/translate, chart render
```

## Publishing (npm trusted publishing / OIDC)

Releases are published through GitHub Actions with npm provenance — no `NPM_TOKEN` secret is stored. The workflow (`.github/workflows/publish.yml`) runs on a version tag (`v*.*.*`) or a manual `workflow_dispatch` run from `main`, gives itself `contents: read` + `id-token: write`, uses Node 24 and npm 11.21.2, then runs `npm ci` → typecheck → build → test → `npm publish --provenance --access public`. Tag pushes must be `v` followed by the exact `package.json` version (for example, `v0.1.0`); manual runs publish the version in `main`.

Before the first OIDC release, an npm maintainer must configure the trusted publisher on npmjs.com. npm only exposes these settings for an existing package; an unclaimed package cannot be bootstrapped by this OIDC workflow alone.

1. Open the `ai-sdk-ava` package **Settings → Trusted Publisher** (also reachable from **Publishing access**) and select **GitHub Actions**.
2. Add a trusted publisher entry with these case-sensitive values:
   - **Organization or user:** `DoubleCore`
   - **Repository:** `ai-sdk-ava`
   - **Workflow filename:** `publish.yml` (only the filename, not the full path)
   - **Environment name:** (leave empty — the workflow defines no GitHub environment)
   - **Allowed actions:** enable **`npm publish`**, because this workflow publishes directly rather than using `npm stage publish`.
3. Complete the first successful publish within two days of creating the trust configuration, or npm will expire it. After the first OIDC release, consider **Require two-factor authentication and disallow tokens** under **Publishing access**.

To cut a release after that one-time binding is complete: bump the version in `package.json`, push a matching tag:

```bash
npm version patch   # or minor / major; skip if the current version is not published yet
git push --follow-tags
```

The workflow then builds and tests before publishing with a public provenance statement. Package names, scopes and visibility are checked here: `ai-sdk-ava` is a public, unscoped package, hence `--access public`.

## License

MIT
