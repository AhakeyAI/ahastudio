// Ported/adapted from Orca (https://github.com/stablyai/orca),
// NativeChatPacedMarkdown.tsx. Copyright (c) 2026 Lovecast Inc. — MIT License.
// See THIRD_PARTY_NOTICES.md.

import { memo, type ComponentProps } from 'react';
import { SessionMarkdown } from './SessionMarkdown';
import { useSessionPacedText } from './useSessionPacedText';

/** Isolates paced text updates so animation frames do not re-render surrounding row chrome. */
export const SessionPacedMarkdown = memo(function SessionPacedMarkdown({
  rowKey,
  text,
  streaming,
  ...props
}: Omit<ComponentProps<typeof SessionMarkdown>, 'fadeWords'> & {
  rowKey: string;
  streaming: boolean;
}) {
  const paced = useSessionPacedText(rowKey, text, streaming);
  return (
    <SessionMarkdown
      {...props}
      rowKey={rowKey}
      text={paced.text}
      streaming={streaming || paced.revealing}
      fadeWords={paced.fading}
    />
  );
});
