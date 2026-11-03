/**
 * Answer controls of a waiting ask block, shared by the card above the canvas and the block's Run output: a button
 * per choice (up to five), a list for more, or a text field; plus the time left before the default is used.
 * The control to start from (the default choice, Answer under the list, or the text field) carries `data-ask-primary`.
 */
import './ask.css';
import { useState } from 'react';
import type { AskPrompt } from '@isar-flow/core';
import { Button, Select, TextInput } from '../../../components';
import { useNow } from '../inspector/useNow';
import { deadlineText } from './deadline';

/** More choices than this are offered as a list. */
const MAX_CHOICE_BUTTONS = 5;

/** The question names the answer buttons; without one they are just "Answers". */
const groupName = (questionId: string | undefined) =>
  questionId ? { 'aria-labelledby': questionId } : { 'aria-label': 'Answers' };

function ChoiceButtons({ prompt, choices, questionId, onAnswer }: AskFormProps & { choices: string[] }) {
  const primary = choices.includes(prompt.default ?? '') ? prompt.default : choices[0];
  return (
    <div className="wf-ask__choices" role="group" {...groupName(questionId)}>
      {choices.map((choice) => {
        const isDefault = choice === prompt.default;
        return (
          <Button
            key={choice}
            size="s"
            className="wf-ask__choice"
            variant={isDefault ? 'primary' : 'secondary'}
            // A check, not only the color, marks the default: high contrast themes draw both variants alike.
            icon={isDefault ? 'check' : undefined}
            title={isDefault ? 'Default answer' : undefined}
            data-ask-primary={choice === primary ? '' : undefined}
            onClick={() => onAnswer(choice)}
          >
            {choice}
            {isDefault ? <span className="if-visually-hidden">, default</span> : null}
          </Button>
        );
      })}
    </div>
  );
}

function ChoiceList({ prompt, choices, questionId, onAnswer }: AskFormProps & { choices: string[] }) {
  const [value, setValue] = useState(prompt.default ?? choices[0]);
  return (
    <div className="wf-ask__row">
      <div className="wf-ask__field">
        <Select
          ariaLabel="Answer from the list"
          describedBy={questionId}
          value={value}
          searchable={choices.length > 8}
          options={choices.map((choice) => ({
            value: choice,
            label: choice,
            meta: choice === prompt.default ? 'Default' : undefined,
          }))}
          onChange={setValue}
        />
      </div>
      {/* The default is already chosen in the list, so Answer is where Enter answers with it. */}
      <Button size="s" variant="primary" data-ask-primary="" onClick={() => onAnswer(value)}>
        Answer
      </Button>
    </div>
  );
}

function FreeText({ prompt, questionId, onAnswer }: AskFormProps) {
  const [text, setText] = useState(prompt.default ?? '');
  const answer = text.trim() || prompt.default;
  const submit = () => {
    if (answer !== undefined && answer !== '') onAnswer(answer);
  };
  return (
    <div className="wf-ask__row">
      <TextInput
        className="wf-ask__field"
        aria-label="Answer"
        aria-describedby={questionId}
        placeholder="Your answer"
        data-ask-primary=""
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          submit();
        }}
      />
      <Button size="s" variant="primary" disabled={!answer} onClick={submit}>
        Answer
      </Button>
    </div>
  );
}

function Deadline({ prompt }: { prompt: AskPrompt }) {
  const expiresAt = prompt.expiresAt;
  const now = useNow(expiresAt !== undefined);
  if (expiresAt === undefined) return null;
  return <p className="wf-ask__deadline">{deadlineText(expiresAt, now, prompt.default)}</p>;
}

export interface AskFormProps {
  prompt: AskPrompt;
  /** Id of the element showing the question: it names the answer buttons and describes the fields. */
  questionId?: string;
  onAnswer: (answer: string) => void;
}

export function AskForm(props: AskFormProps) {
  const { prompt } = props;
  const choices = Array.isArray(prompt.choices) ? prompt.choices : [];
  return (
    <div className="wf-ask">
      {choices.length === 0 ? (
        <FreeText {...props} />
      ) : choices.length <= MAX_CHOICE_BUTTONS ? (
        <ChoiceButtons {...props} choices={choices} />
      ) : (
        <ChoiceList {...props} choices={choices} />
      )}
      <Deadline prompt={prompt} />
    </div>
  );
}
