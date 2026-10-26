import { DOCUMENT_CHANGED, type EditorDocument, WRITE_FAILED } from './host';

/** How often an edit is planned when the text keeps changing before VS Code applies it. */
const MAX_ATTEMPTS = 3;

export type EditOutcome = { status: 'applied' | 'unchanged' } | { status: 'failed'; error: string };

/** Turns the current text into the edited text, or explains why the edit is not possible. */
export type EditPlan = (text: string) => { text: string; error?: string };

/**
 * Applies the semantic edits of a panel (canvas ops, form updates) one at a time, each planned on the current
 * text. VS Code refuses an edit made for an older version of the document, which happens when the user types
 * in the YAML editor meanwhile; the edit is then planned again on the new text.
 */
export class EditQueue {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly document: EditorDocument) {}

  apply(plan: EditPlan): Promise<EditOutcome> {
    const next = this.queue.then(() => this.attempt(plan));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async attempt(plan: EditPlan): Promise<EditOutcome> {
    for (let attempt = 1; ; attempt++) {
      const text = this.document.getText();
      const result = plan(text);
      if (result.error !== undefined) return { status: 'failed', error: result.error };
      if (result.text === text) return { status: 'unchanged' };
      if (await this.document.replaceText(text, result.text)) return { status: 'applied' };
      if (this.document.getText() === text) return { status: 'failed', error: WRITE_FAILED };
      if (attempt >= MAX_ATTEMPTS) return { status: 'failed', error: DOCUMENT_CHANGED };
    }
  }
}
