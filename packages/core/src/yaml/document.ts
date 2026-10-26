import {
  type Document,
  isCollection,
  isMap,
  isNode,
  isSeq,
  parseDocument,
  visit,
  type YAMLError,
  YAMLMap,
  YAMLSeq,
} from 'yaml';

/** Duplicate keys are errors: the canvas could not tell which value wins. */
export const PARSE_OPTIONS = { uniqueKeys: true, prettyErrors: true } as const;

/** A user-facing problem with an edit; the message is shown as is. */
export class EditError extends Error {}

export interface YamlProblem {
  message: string;
  start: number;
  end: number;
}

const DUPLICATE_KEY = /^("[^"\r\n]*"|'[^'\r\n]*'|[^:#\r\n]+?)(?=[ \t]*:)/;

/** Turns a parser error into a plain message without the parser's own position details. */
export function describeYamlError(error: YAMLError, text: string): YamlProblem {
  const [start, end] = error.pos;
  const raw = error.message.replace(/ at line \d+, column \d+[\s\S]*$/, '').trim();
  switch (error.code) {
    case 'DUPLICATE_KEY': {
      const key = DUPLICATE_KEY.exec(text.slice(start))?.[1];
      return key
        ? {
            message: `Duplicate key '${key}'. Each key may appear only once in a mapping.`,
            start,
            end: start + key.length,
          }
        : { message: 'Duplicate key. Each key may appear only once in a mapping.', start, end };
    }
    case 'MULTIPLE_DOCS':
      return {
        message:
          'The file contains more than one YAML document (separated by ---). Keep everything in a single document.',
        start,
        end,
      };
    case 'TAB_AS_INDENT':
      return { message: 'Tabs are not allowed for indentation in YAML. Use spaces instead.', start, end };
    default:
      return { message: `YAML syntax error: ${raw}`, start, end };
  }
}

export interface TextFormat {
  indent: number;
  /** Whether block sequences inside mappings are indented (`key:\n  - a`) or not (`key:\n- a`). */
  indentSeq: boolean;
  crlf: boolean;
  bom: boolean;
}

function columnOf(text: string, offset: number): number {
  const lineStart = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1;
  return offset - lineStart;
}

/**
 * Detects how the file is laid out so re-serializing does not reformat untouched content. The `yaml`
 * package applies one indentation style to the whole document, so it must match the source.
 * `text` is the parsed text without a byte order mark.
 */
function detectTextFormat(doc: Document, text: string, bom: boolean): TextFormat {
  const firstBreak = text.indexOf('\n');
  let indent: number | undefined;
  let seqOffset: number | undefined;
  const scan = (node: unknown): void => {
    if (indent !== undefined && seqOffset !== undefined) return;
    if (isMap(node) && !node.flow) {
      for (const pair of node.items) {
        const { key, value } = pair;
        if (
          isNode(key) &&
          key.range &&
          isCollection(value) &&
          !value.flow &&
          value.range &&
          value.items.length > 0
        ) {
          const offset = columnOf(text, value.range[0]) - columnOf(text, key.range[0]);
          if (isMap(value) && indent === undefined && offset > 0) indent = offset;
          if (isSeq(value) && seqOffset === undefined) seqOffset = offset;
        }
        scan(value);
      }
    } else if (isSeq(node) && !node.flow) {
      node.items.forEach(scan);
    }
  };
  scan(doc.contents);
  const detected = indent ?? (seqOffset !== undefined && seqOffset > 0 ? seqOffset : 2);
  return {
    indent: detected >= 1 && detected <= 8 ? detected : 2,
    indentSeq: seqOffset === undefined || seqOffset > 0,
    crlf: firstBreak > 0 && text[firstBreak - 1] === '\r',
    bom,
  };
}

const PADDING = Symbol('isarFlow.flowPadding');
type FlowCollection = (YAMLMap | YAMLSeq) & { [PADDING]?: boolean };
type StringifyArgs = Parameters<YAMLSeq['toString']>;

/**
 * The `yaml` package pads all flow collections the same way (`[ a ]` or `[a]`). This override lets a single
 * collection keep its own style. It reads `this`, so `clone()` (which copies own properties) keeps working.
 */
function paddedToString(this: FlowCollection, ...[ctx, onComment, onChompKeep]: StringifyArgs): string {
  const padding = this[PADDING];
  const next = ctx && padding !== undefined ? { ...ctx, flowCollectionPadding: padding ? ' ' : '' } : ctx;
  return isSeq(this)
    ? YAMLSeq.prototype.toString.call(this, next, onComment, onChompKeep)
    : YAMLMap.prototype.toString.call(this, next, onComment, onChompKeep);
}

export function setFlowPadding(node: YAMLMap | YAMLSeq, padded: boolean): void {
  const target = node as FlowCollection;
  target[PADDING] = padded;
  target.toString = paddedToString;
}

/** Records the bracket padding of every non-empty flow collection as written in the source. */
function pinFlowPadding(doc: Document, text: string): void {
  const pin = (node: YAMLMap | YAMLSeq) => {
    if (!node.flow || !node.range || node.items.length === 0) return;
    const open = node.range[0];
    if (text[open] !== '[' && text[open] !== '{') return;
    setFlowPadding(node, /\s/.test(text[open + 1] ?? ''));
  };
  visit(doc, { Map: (_, node) => pin(node), Seq: (_, node) => pin(node) });
}

export interface EditableDocument {
  doc: Document;
  root: YAMLMap;
  format: TextFormat;
  /** True when the file had no content and `root` was created for the edit. */
  createdRoot: boolean;
}

const BOM = '﻿';

/** Parses text for editing. Empty documents become an empty mapping; anything unparsable is refused. */
export function loadForEdit(text: string, what: 'workflow' | 'agent'): EditableDocument {
  // The mark is put back by stringifyDocument; leaving it in would shift the columns of the first line.
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(BOM.length) : text;
  const doc: Document = parseDocument(body, PARSE_OPTIONS);
  if (doc.errors.length > 0) {
    const problem = describeYamlError(doc.errors[0], body);
    const line = body.slice(0, problem.start).split(/\r\n|\r|\n/).length;
    throw new EditError(
      `The ${what} file has YAML errors. Fix them in the text editor first (line ${line}: ${problem.message})`,
    );
  }
  const format = detectTextFormat(doc, body, bom);
  pinFlowPadding(doc, body);
  const createdRoot = doc.contents === null;
  if (createdRoot) doc.contents = new YAMLMap(doc.schema);
  if (!isMap(doc.contents)) {
    throw new EditError(`The ${what} file must contain a YAML mapping (key: value pairs) at the top level.`);
  }
  return { doc, root: doc.contents, format, createdRoot };
}

/** Serializes the edited document; `original` is returned when an empty file was left without content. */
export function stringifyDocument(edit: EditableDocument, original: string): string {
  if (edit.createdRoot && edit.root.items.length === 0) return original;
  const { doc, format } = edit;
  let out = doc.toString({ lineWidth: 0, indent: format.indent, indentSeq: format.indentSeq });
  if (format.crlf) out = out.replace(/\n/g, '\r\n');
  return format.bom ? BOM + out : out;
}
