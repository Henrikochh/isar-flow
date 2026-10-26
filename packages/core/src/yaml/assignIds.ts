import { type Document, isNode, isScalar, Pair, Scalar, type YAMLMap } from 'yaml';
import { STEP_ID_PATTERN } from '../schema';
import { STEP_TYPES } from '../schema/steps';
import { walkBlockNodes } from './locate';
import { findPair } from './nodePath';

const isStepType = (type: unknown): type is string =>
  typeof type === 'string' && (STEP_TYPES as readonly string[]).includes(type);

function setBlockId(doc: Document, block: YAMLMap, id: string): void {
  const pair = findPair(block, 'id');
  if (pair && isScalar(pair.value)) {
    // Replaced in place so a comment on the value survives; quotes of the old value are not needed.
    pair.value.value = id;
    pair.value.type = Scalar.PLAIN;
  } else if (pair) {
    pair.value = doc.createNode(id);
  } else {
    const key = doc.createNode('id');
    // A comment above the first key describes the block, so it stays above the block's first line.
    const first = block.items[0];
    if (first && isNode(first.key) && first.key.commentBefore) {
      key.commentBefore = first.key.commentBefore;
      first.key.commentBefore = undefined;
    }
    block.items.unshift(new Pair(key, doc.createNode(id)));
  }
}

/** Gives every block without a valid string id a fresh `<type>_<n>` id that no other block uses. */
export function assignMissingIds(doc: Document, root: YAMLMap): void {
  const used = new Set<string>();
  const missing: YAMLMap[] = [];
  walkBlockNodes(root, ({ node, id }) => {
    if (id !== undefined && STEP_ID_PATTERN.test(id)) used.add(id);
    else missing.push(node);
  });
  for (const block of missing) {
    const type: unknown = block.get('type');
    const base = isStepType(type) ? type : 'block';
    let n = 1;
    while (used.has(`${base}_${n}`)) n++;
    const id = `${base}_${n}`;
    used.add(id);
    setBlockId(doc, block, id);
  }
}
