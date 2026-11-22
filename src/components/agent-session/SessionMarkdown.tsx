import { Children, isValidElement, memo, type KeyboardEvent, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { routeNativeChatHref } from '../../lib/shared/native-chat/native-chat-href-routing';
import { CodeBlock } from './SessionCode';
import { openSessionTarget, useAgentSession } from './session-context';

const REMARK_PLUGINS = [remarkGfm];

/** Target handed to the main process, or null when the href is not something we open. */
function linkTarget(href: string | undefined): string | null {
  const route = routeNativeChatHref(href);
  if (route.kind === 'web') return route.url;
  if (route.kind === 'file') return route.line ? `${route.pathText}:${route.line}` : route.pathText;
  return null;
}

/** Hrefs are kept only as data: every link is opened through IPC and never navigates the window. */
const keepRoutableHref = (url: string): string => (linkTarget(url) ? url : '');

function SessionLink({ href, children }: { href?: string; children?: ReactNode }) {
  const session = useAgentSession();
  const target = linkTarget(href);
  if (!target) return <span className="asv-md-deadlink">{children}</span>;
  const open = () => void openSessionTarget(target, session);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') open();
  };
  return (
    <a className="asv-md-link" role="link" tabIndex={0} title={target} onClick={open} onKeyDown={onKeyDown}>
      {children}
    </a>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => <SessionLink href={href}>{children}</SessionLink>,
  // Remote images would fetch on render, so they are shown as a link to open on request.
  img: ({ src, alt }) => <SessionLink href={typeof src === 'string' ? src : undefined}>{alt || '图片'}</SessionLink>,
  table: ({ children }) => (
    <div className="asv-md-table">
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => {
    const child = Children.toArray(children)[0];
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre>{children}</pre>;
    const info = /language-(\S+)/.exec(child.props.className ?? '')?.[1] ?? '';
    return <CodeBlock info={info} code={String(child.props.children ?? '').replace(/\n$/, '')} />;
  },
};

/**
 * Agent and task text as GitHub-flavoured Markdown. Raw HTML in the source is never parsed: it
 * is shown as literal text, so model output can only ever produce Markdown's own elements.
 */
export const SessionMarkdown = memo(function SessionMarkdown({
  text,
  variant = 'prose',
  streaming = false,
}: {
  text: string;
  variant?: 'prose' | 'bubble' | 'muted';
  streaming?: boolean;
}) {
  return (
    <div className={`asv-md is-${variant}`} data-streaming={streaming || undefined}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} urlTransform={keepRoutableHref}>
        {text}
      </Markdown>
    </div>
  );
});
