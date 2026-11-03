/**
 * An ask block waiting for an answer: pinned above the canvas like an approval, in the same tone as the ring of the
 * waiting block. The question is the largest text in it.
 */
import { useId } from 'react';
import type { AskPrompt } from '@isar-flow/core';
import { Banner } from '../../../components';
import { AskForm } from '../ask/AskForm';
import { blockTitle } from '../canvas/model';
import { useEditor } from '../editorContext';
import { useWorkflowActions } from '../store';

export function AskBanner({ prompt }: { prompt: AskPrompt }) {
  const { answerAsk, select } = useWorkflowActions();
  const { model } = useEditor();
  const questionId = useId();
  const entry = model.byId.get(prompt.stepId);
  return (
    <Banner
      tone="success"
      icon="comment-discussion"
      title={
        <span className="wf-banner-title">
          <span>Question</span>
          {entry ? (
            <button type="button" className="wf-banner-link" onClick={() => select(prompt.stepId)}>
              {blockTitle(entry)}
            </button>
          ) : null}
        </span>
      }
      actions={
        <AskForm
          prompt={prompt}
          questionId={questionId}
          onAnswer={(answer) => answerAsk(prompt.requestId, answer)}
        />
      }
    >
      <span id={questionId} className="wf-banner-message wf-ask-question">
        {prompt.question}
      </span>
    </Banner>
  );
}
