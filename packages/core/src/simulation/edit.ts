import { isMap, isScalar, isNode, Pair, parseDocument, YAMLMap } from 'yaml';
import type { SimulationResult } from '../schema/types';
import { STEP_ID_PATTERN } from '../schema/zod';
import {
  describeYamlError,
  type EditableDocument,
  loadForEdit,
  PARSE_OPTIONS,
  stringifyDocument,
} from '../yaml/document';
import { findPair } from '../yaml/nodePath';
import { deleteMapKey, insertPair, setMapValue } from '../yaml/nodes';
import { newSimulationText } from './template';

const BOM = '﻿';
const FILE_KEY_ORDER = ['version', 'approvals', 'blocks'];
const RESULT_KEY_ORDER = [
  'exitCode',
  'output',
  'text',
  'json',
  'approved',
  'comment',
  'answer',
  'error',
] as const;

function cannotRead(reason: string): Error {
  return new Error(`The simulation file can't be read: ${reason}. Fix it in the file first.`);
}

/** Parses for editing; refuses text with YAML errors or without a mapping at the top, so nothing gets lost. */
function loadMocks(text: string): EditableDocument {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const doc = parseDocument(body, PARSE_OPTIONS);
  if (doc.errors.length > 0) {
    const problem = describeYamlError(doc.errors[0], body);
    const line = body.slice(0, problem.start).split(/\r\n|\r|\n/).length;
    throw cannotRead(`${problem.message.replace(/\.$/, '')} (line ${line})`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw cannotRead('it must be a mapping with version and blocks at the top level');
  }
  // Can't throw anymore: the checks above cover its refusals.
  return loadForEdit(text, 'workflow');
}

function ensureVersion(edit: EditableDocument): void {
  const { doc, root } = edit;
  if (findPair(root, 'version')) return;
  const pair = new Pair(doc.createNode('version'), doc.createNode(1));
  insertPair(root, pair, FILE_KEY_ORDER);
  // A header comment above the first key belongs above the file, so it stays on top.
  const next = root.items[root.items.indexOf(pair) + 1];
  if (root.items[0] === pair && next && isNode(next.key) && next.key.commentBefore && isNode(pair.key)) {
    pair.key.commentBefore = next.key.commentBefore;
    next.key.commentBefore = undefined;
  }
}

function blocksMap(edit: EditableDocument): YAMLMap {
  const { doc, root } = edit;
  const pair = findPair(root, 'blocks');
  if (pair && isMap(pair.value)) return pair.value;
  const empty = !pair || pair.value === null || (isScalar(pair.value) && pair.value.value === null);
  if (!empty) throw cannotRead('"blocks" must be a mapping of block ids to lists of results');
  const map = new YAMLMap(doc.schema);
  if (pair) {
    if (isScalar(pair.value) && pair.value.comment) map.commentBefore = pair.value.comment;
    pair.value = map;
  } else {
    insertPair(root, new Pair(doc.createNode('blocks'), map), FILE_KEY_ORDER);
  }
  return map;
}

/**
 * The parser attaches a comment above the first block id to the mapping itself. It describes that block, so it is
 * removed together with it. Comment lines followed by a blank line describe the mapping and stay (the parser marks
 * that blank line with a trailing "\n").
 */
function attachLeadingComment(map: YAMLMap): void {
  const first = map.items[0];
  const comment = map.commentBefore;
  if (!comment || map.flow || !first || !isNode(first.key) || first.key.spaceBefore) return;
  const split = comment.lastIndexOf('\n\n');
  const own = comment.endsWith('\n') ? '' : split === -1 ? comment : comment.slice(split + 2);
  if (own === '') return;
  first.key.commentBefore = first.key.commentBefore ? `${own}\n${first.key.commentBefore}` : own;
  map.commentBefore = own === comment ? undefined : comment.slice(0, split + 1);
}

/** Plain copy of a result with its keys in the documented order; unknown and undefined fields are left out. */
function orderedResult(result: SimulationResult): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of RESULT_KEY_ORDER) if (result[key] !== undefined) ordered[key] = result[key];
  return ordered;
}

/**
 * Sets the mocks of one block in a simulation file and keeps comments and everything else; null or [] removes
 * them. Throws when the file can't be read, instead of overwriting it.
 */
export function setSimulationResults(
  text: string,
  stepId: string,
  results: SimulationResult[] | null,
): string {
  if (!STEP_ID_PATTERN.test(stepId)) {
    throw new Error(
      `"${stepId}" isn't a valid block id. Block ids start with a letter or _ and contain only letters, digits, _ and -.`,
    );
  }
  const source = text.trim() === '' ? newSimulationText('') : text;
  const edit = loadMocks(source);
  const remove = !results || results.length === 0;
  const existing = findPair(edit.root, 'blocks')?.value;
  if (remove && !(isMap(existing) && findPair(existing, stepId))) return text;

  ensureVersion(edit);
  const blocks = blocksMap(edit);
  if (remove) {
    attachLeadingComment(blocks);
    deleteMapKey(blocks, stepId);
    if (blocks.items.length === 0) blocks.flow = true;
  } else {
    blocks.flow = false;
    setMapValue(edit.doc, blocks, stepId, results.map(orderedResult), 'other');
  }
  return stringifyDocument(edit, source);
}

/**
 * Renames a block's mocks in place (after the block was renamed). Leaves the text unchanged when the old id has
 * no mocks, the new id already has some, the new id isn't valid, or the file can't be read.
 */
export function renameSimulationBlock(text: string, oldId: string, newId: string): string {
  if (oldId === newId || !STEP_ID_PATTERN.test(newId)) return text;
  const offset = text.startsWith(BOM) ? BOM.length : 0;
  const doc = parseDocument(text.slice(offset), PARSE_OPTIONS);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return text;
  const blocks = findPair(doc.contents, 'blocks')?.value;
  if (!isMap(blocks) || findPair(blocks, newId)) return text;
  const key = findPair(blocks, oldId)?.key;
  if (!isScalar(key) || !key.range) return text;
  const [start, end] = key.range;
  return text.slice(0, offset + start) + newId + text.slice(offset + end);
}
