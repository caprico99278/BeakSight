#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load-config.js';
import type { AuditConfigOverrides } from '../config/types.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    headed: { type: 'boolean' },
    headless: { type: 'boolean' },
    output: { type: 'string' },
  },
});

const command = positionals[0];
const overrides: AuditConfigOverrides = {
  ...(values.headed === true ? { browser: { headed: true } } : values.headless === true ? { browser: { headed: false } } : {}),
  ...(values.output === undefined ? {} : { output: { directory: values.output } }),
};

if (command === 'validate-config') {
  await loadConfig(values.config, overrides);
  process.stdout.write('configuration valid\n');
  process.exitCode = 0;
} else if (command === 'run') {
  process.stderr.write('run coordinator is not wired yet\n');
  process.exitCode = 1;
} else {
  process.stderr.write('usage: beaksight <run|validate-config> [options]\n');
  process.exitCode = 4;
}
