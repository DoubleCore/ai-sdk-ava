import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AVA } = require('@antv/ava') as typeof import('@antv/ava');

import type { ChartSpec } from '@antv/ava';

/**
 * Render a chart config from `ava_visualize` into standalone HTML.
 *
 * AVA's `viz()` needs an instance, but rendering a config does not call a model,
 * so a placeholder key is enough. Pass `outputPath` to write the file, or omit it
 * to receive the HTML string.
 */
export async function renderChart(
  spec: ChartSpec,
  options: { outputPath?: string } = {}
): Promise<{ chartType: string; html?: string; path?: string }> {
  const ava = new AVA({ llm: { model: 'gpt-4o-mini', apiKey: 'not-configured' } });
  try {
    const html = await ava.viz(spec);
    if (options.outputPath) {
      await writeFile(options.outputPath, html, 'utf8');
      return { chartType: spec.chartType, path: options.outputPath };
    }
    return { chartType: spec.chartType, html };
  } finally {
    await ava.dispose();
  }
}
