// Generates schemas/workflow.schema.json and schemas/agent.schema.json from @isar-flow/core, so the
// `yamlValidation` contribution always matches the Zod schemas the extension validates with.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaDir = path.join(packageDir, 'schemas');

const ENTRY = "export { workflowJsonSchema, agentJsonSchema } from '@isar-flow/core';";

/** Writes the file only when its content changed, so watchers are not triggered for nothing. */
function writeIfChanged(file, content) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  if (current === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

export async function generateSchemas() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isar-flow-schema-'));
  const bundle = path.join(tempDir, 'schemas.cjs');
  try {
    await esbuild.build({
      stdin: { contents: ENTRY, resolveDir: packageDir, sourcefile: 'schemas-entry.ts', loader: 'ts' },
      bundle: true,
      outfile: bundle,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      logLevel: 'warning',
    });
    const { workflowJsonSchema, agentJsonSchema } = createRequire(import.meta.url)(bundle);
    fs.mkdirSync(schemaDir, { recursive: true });
    const written = [
      ['workflow.schema.json', workflowJsonSchema()],
      ['agent.schema.json', agentJsonSchema()],
    ].filter(([name, schema]) =>
      writeIfChanged(path.join(schemaDir, name), `${JSON.stringify(schema, null, 2)}\n`),
    );
    console.log(
      written.length > 0
        ? `Schemas written: ${written.map(([name]) => `schemas/${name}`).join(', ')}`
        : 'Schemas are up to date.',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateSchemas();
}
