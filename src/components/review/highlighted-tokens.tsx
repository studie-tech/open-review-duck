import { Fragment, type ReactNode } from "react";
import type { SyntaxToken } from "~/lib/highlight-tokens";

/** Values available when a surface needs to decorate one highlighted token. */
export interface HighlightedTokenRenderContext {
  children: string;
  className: string | undefined;
  token: SyntaxToken;
}

/**
 * Renders one syntax-highlighted line without imposing row or code-block layout.
 *
 * The primitive owns token keys, syntax classes, and the visible placeholder
 * for an empty line. Callers only provide a renderer when a token needs an
 * interaction such as symbol peeking or import navigation.
 */
export function HighlightedTokens({
  tokens,
  renderToken,
}: {
  tokens: readonly SyntaxToken[];
  renderToken?: (context: HighlightedTokenRenderContext) => ReactNode;
}) {
  if (tokens.length === 0) return " ";
  return tokens.map((token, index) => {
    const className = token.className || undefined;
    return (
      <Fragment key={`${token.from}:${token.to}:${index}`}>
        {renderToken ? (
          renderToken({
            children: token.text,
            className,
            token,
          })
        ) : (
          <span className={className}>{token.text}</span>
        )}
      </Fragment>
    );
  });
}
