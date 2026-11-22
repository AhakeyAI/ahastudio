import type { ReactNode } from 'react';
import type { SyntaxToken } from '../lib/code-syntax-highlight';

export function renderLineTokens(tokens: readonly SyntaxToken[]): ReactNode {
  if (tokens.length === 0) return null;
  return tokens.map((tok, i) =>
    tok.color || tok.italic ? (
      <span
        key={i}
        style={
          tok.color && tok.italic
            ? { color: tok.color, fontStyle: 'italic' }
            : tok.color
              ? { color: tok.color }
              : { fontStyle: 'italic' }
        }
      >
        {tok.text}
      </span>
    ) : (
      tok.text
    )
  );
}
