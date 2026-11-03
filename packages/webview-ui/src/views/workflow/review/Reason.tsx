import { type ReactNode, useId } from 'react';

/** Props for a control that is disabled for a reason: the reason is its tooltip and its description. */
export interface ReasonProps {
  disabled: boolean;
  title?: string;
  'aria-describedby'?: string;
}

/**
 * Wraps a control that may be disabled for a reason. The reason shows as a tooltip on the control and on the
 * wrapper (browsers differ in whether disabled controls get one) and describes the control for screen readers.
 */
export function Reason({
  reason,
  children,
}: {
  reason: string | undefined;
  children: (props: ReasonProps | Record<string, never>) => ReactNode;
}) {
  const id = useId();
  if (!reason) return <>{children({})}</>;
  return (
    <span className="wf-review-reason" title={reason}>
      {children({ disabled: true, title: reason, 'aria-describedby': id })}
      <span id={id} className="if-visually-hidden">
        {reason}
      </span>
    </span>
  );
}
