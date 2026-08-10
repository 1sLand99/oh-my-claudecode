import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { pythonReplTool } from '../tool.js';
import { pythonReplTool as pythonReplToolIndex } from '../index.js';
import { buildListToolsResponse } from '../../../mcp/tool-registry.js';
import { scientistAgent, SCIENTIST_PROMPT_METADATA } from '../../../agents/scientist.js';
import { loadAgentPrompt } from '../../../agents/utils.js';

// Every user-facing guidance surface for python_repl must match the bridge
// sandbox (bridge/gyoshu_bridge.py): imports, file I/O, dynamic code
// execution, and third-party libraries are blocked; only built-in functions
// and persistent variables are available (issue #3682). Surfaces below may
// NAME a blocked library to say it is blocked, but must never ADVERTISE or
// DIRECT imports, file I/O, library APIs, ML, or plotting workflows.

const THIRD_PARTY_LIBRARIES = [
  'pandas',
  'numpy',
  'scipy',
  'matplotlib',
  'plotly',
  'sklearn',
  'seaborn',
  'statsmodels',
];

const FILE_IO_DIRECTIVES = [
  'read_csv',
  'read_excel',
  'read_json',
  'read_parquet',
  'read_pickle',
  'to_csv',
  'to_pickle',
  'savefig',
  'os.walk',
  'np.load',
  'np.save',
  'memmap',
  'ctypeslib',
];

const LIBRARY_API_DIRECTIVES = [
  'dataframe',
  'plt.',
  '.head(',
  '.describe(',
  'value_counts',
  'agg backend',
  'pip install',
];

const IMPORT_DIRECTIVES = [
  'import pandas',
  'import numpy',
  'import matplotlib',
  'import os',
  'import json',
  'from pathlib',
];

const ML_DIRECTIVES = ['simple ml', 'clustering or regression', 'ml model training', 'ml/hypothesis', 'data science'];

const SCIENTIST_WORKFLOW_DIRECTIVES = [
  'data files',
  'load data',
  'read data',
  'visualizations',
  'figures/',
];

describe('python_repl sandbox guidance parity (#3682)', () => {
  const listToolsDescription = (() => {
    const { tools } = buildListToolsResponse('');
    const python = tools.find((t) => t.name === 'python_repl');
    if (!python) throw new Error('python_repl missing from standalone ListTools surface');
    return python.description;
  })();

  const toolSurfaces: [string, string][] = [
    ['tool.ts MCP-facing description', pythonReplTool.description],
    ['index.ts in-process server description', pythonReplToolIndex.description],
    ['standalone ListTools surface', listToolsDescription],
  ];

  const allToolTerms = [
    ...THIRD_PARTY_LIBRARIES,
    ...FILE_IO_DIRECTIVES,
    ...LIBRARY_API_DIRECTIVES,
    ...IMPORT_DIRECTIVES,
    ...ML_DIRECTIVES,
  ];

  for (const [name, text] of toolSurfaces) {
    it(`${name} does not advertise blocked libraries, file I/O, imports, or ML`, () => {
      const lower = text.toLowerCase();
      for (const term of allToolTerms) {
        expect(lower, `${name} must not contain "${term}"`).not.toContain(term);
      }
    });

    it(`${name} states the sandbox boundary`, () => {
      const lower = text.toLowerCase();
      expect(lower).toContain('imports');
      expect(lower).toContain('file i/o');
      expect(lower).toContain('blocked');
    });
  }

  describe('scientist agent guidance', () => {
    const scientistSurfaces: [string, string][] = [
      ['scientistAgent.description', scientistAgent.description],
      [
        'SCIENTIST_PROMPT_METADATA triggers/useWhen/avoidWhen',
        JSON.stringify([
          SCIENTIST_PROMPT_METADATA.triggers,
          SCIENTIST_PROMPT_METADATA.useWhen,
          SCIENTIST_PROMPT_METADATA.avoidWhen,
        ]),
      ],
      ['agents/scientist.md prompt', loadAgentPrompt('scientist')],
    ];

    const scientistTerms = [
      ...FILE_IO_DIRECTIVES,
      ...LIBRARY_API_DIRECTIVES,
      ...IMPORT_DIRECTIVES,
      ...ML_DIRECTIVES,
      ...SCIENTIST_WORKFLOW_DIRECTIVES,
    ];

    for (const [name, text] of scientistSurfaces) {
      it(`${name} does not direct file I/O, library APIs, imports, ML, or plotting workflows`, () => {
        const lower = text.toLowerCase();
        for (const term of scientistTerms) {
          expect(lower, `${name} must not direct "${term}"`).not.toContain(term);
        }
      });

      it(`${name} states the sandbox boundary and built-in-only computation`, () => {
        const lower = text.toLowerCase();
        expect(lower).toContain('sandbox');
        expect(lower).toContain('built-in');
      });
    }
  });

  describe('repo documentation surfaces', () => {
    const agentsDocs = readFileSync(
      fileURLToPath(new URL('../../../agents/AGENTS.md', import.meta.url)),
      'utf-8',
    );
    const tiersDocs = readFileSync(
      fileURLToPath(new URL('../../../../docs/shared/agent-tiers.md', import.meta.url)),
      'utf-8',
    );
    const toolsDocs = readFileSync(
      fileURLToPath(new URL('../../../../docs/TOOLS.md', import.meta.url)),
      'utf-8',
    );
    const referenceDocs = readFileSync(
      fileURLToPath(new URL('../../../../docs/REFERENCE.md', import.meta.url)),
      'utf-8',
    );

    it('src/agents/AGENTS.md does not advertise ML/hypothesis or scientific libraries for scientist agents', () => {
      const lower = agentsDocs.toLowerCase();
      expect(lower).not.toContain('ml/hypothesis');
      for (const lib of THIRD_PARTY_LIBRARIES) {
        expect(lower).not.toContain(lib);
      }
    });

    it('docs/shared/agent-tiers.md does not advertise ML/hypothesis or scientific libraries for scientist agents', () => {
      const lower = tiersDocs.toLowerCase();
      expect(lower).not.toContain('ml/hypothesis');
      for (const lib of THIRD_PARTY_LIBRARIES) {
        expect(lower).not.toContain(lib);
      }
    });

    it('docs/TOOLS.md python_repl section does not advertise scientific libraries or file-IO directives', () => {
      const lower = toolsDocs.toLowerCase();
      for (const term of [...THIRD_PARTY_LIBRARIES, ...FILE_IO_DIRECTIVES, 'dataframe', 'plt.']) {
        expect(lower).not.toContain(term);
      }
    });

    it('docs/REFERENCE.md does not advertise ML/hypothesis or scientific libraries for scientist agents', () => {
      const lower = referenceDocs.toLowerCase();
      expect(lower).not.toContain('ml/hypothesis');
      for (const lib of THIRD_PARTY_LIBRARIES) {
        expect(lower).not.toContain(lib);
      }
    });
  });
});
