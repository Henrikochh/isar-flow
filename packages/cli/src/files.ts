import fs from 'node:fs';
import { CliError, errorMessage } from './errors';

/** A UTF-8 text file without its byte order mark; undefined when it does not exist. */
export async function readTextFile(file: string): Promise<string | undefined> {
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CliError(`Could not read ${file}: ${errorMessage(error)}`);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** The first of `files` that exists, with its text. */
export async function readFirstTextFile(
  files: string[],
): Promise<{ file: string; text: string } | undefined> {
  for (const file of files) {
    const text = await readTextFile(file);
    if (text !== undefined) return { file, text };
  }
  return undefined;
}
