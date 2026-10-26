import { type KeyboardEvent, type RefObject, useEffect, useRef } from 'react';
import type { InsertTarget } from '@isar-flow/core';
import { useEditor } from '../editorContext';
import { useWorkflowActions, useWorkflowState } from '../store';
import type { BlockMenuActions } from './BlockMenu';
import { moveWithinList, selectionAfterDelete } from './ops';

const FOCUSABLE = 'input, textarea, select, button:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The focusable card (or container header) of a block. Compares data attributes, so any id is safe. */
export function cardElement(root: HTMLElement | null, id: string): HTMLElement | null {
  const cards = root?.querySelectorAll<HTMLElement>('[data-wf-card]') ?? [];
  return Array.from(cards).find((el) => el.dataset.stepId === id) ?? null;
}

/** Moves keyboard focus to the first control of the inspector column. */
export function focusInspector(): boolean {
  const panel = document.querySelector<HTMLElement>('[data-wf-inspector]');
  const target = panel?.querySelector<HTMLElement>(FOCUSABLE);
  target?.focus();
  return Boolean(target);
}

/**
 * Canvas shortcuts: arrows move the selection in document order, Delete/Backspace deletes, Ctrl/Cmd+D
 * duplicates, Alt+Up/Down moves the block within its list, Shift+F10 (or the menu key) opens the block menu,
 * Enter focuses the inspector, Escape clears. The block actions are shared with the block menu, so focus
 * follows the block after an edit either way.
 */
export function useCanvasKeyboard(
  rootRef: RefObject<HTMLElement | null>,
  openMenu: (stepId: string) => void,
) {
  const { model, editable, edit } = useEditor();
  const { selection } = useWorkflowState();
  const { select, applyOps, openYaml } = useWorkflowActions();
  /** Set when an edit re-renders the selected card, so focus follows it once the new document arrives. */
  const refocus = useRef(false);

  const focusCard = (id: string) => requestAnimationFrame(() => cardElement(rootRef.current, id)?.focus());

  useEffect(() => {
    if (!refocus.current || !selection) return;
    refocus.current = false;
    focusCard(selection);
    // Runs when the model changes after an edit.
  }, [model]);

  const blockActions: BlockMenuActions = {
    duplicate: (stepId) => {
      refocus.current = true;
      applyOps([{ op: 'duplicateStep', stepId }]);
    },
    remove: (stepId) => {
      const next = selectionAfterDelete(model, stepId);
      refocus.current = true;
      edit({ ops: [{ op: 'deleteStep', stepId }] });
      select(next);
    },
    move: (stepId, target: InsertTarget) => {
      refocus.current = true;
      edit({ ops: [{ op: 'moveStep', stepId, target }], select: stepId });
    },
    openYaml,
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target !== rootRef.current && !target.hasAttribute('data-wf-card')) return;
    const entry = selection ? model.byId.get(selection) : undefined;
    const mod = event.ctrlKey || event.metaKey;
    const go = (delta: number) => {
      const order = model.order;
      if (!order.length) return;
      const index = entry?.id ? order.indexOf(entry.id) : -1;
      const next =
        index < 0
          ? delta > 0
            ? 0
            : order.length - 1
          : Math.min(order.length - 1, Math.max(0, index + delta));
      select(order[next]);
      focusCard(order[next]);
    };

    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      if (!entry?.id || !editable) return;
      event.preventDefault();
      openMenu(entry.id);
      return;
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (!entry || !editable) return;
      const siblings = entry.parent
        ? (entry.parent.children.find((l) => l.info.key === entry.list.key)?.entries.length ?? 0)
        : model.root.entries.length;
      const op = moveWithinList(entry, event.key === 'ArrowUp' ? -1 : 1, siblings);
      if (op) {
        refocus.current = true;
        applyOps([op]);
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        go(1);
        return;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        go(-1);
        return;
      case 'Delete':
      case 'Backspace':
        if (!entry?.id || !editable) return;
        event.preventDefault();
        blockActions.remove(entry.id);
        return;
      case 'Enter':
        if (!entry) return;
        event.preventDefault();
        focusInspector();
        return;
      case 'Escape':
        if (!selection) return;
        event.preventDefault();
        select(null);
        rootRef.current?.focus();
        return;
      default:
        if (mod && event.key.toLowerCase() === 'd' && entry?.id && editable) {
          event.preventDefault();
          blockActions.duplicate(entry.id);
        }
    }
  };

  return { onKeyDown, blockActions };
}
