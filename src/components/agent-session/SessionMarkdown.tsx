// Word-fade settling, inline workspace file path detection, and double-tilde GFM adapted from Orca
// (https://github.com/stablyai/orca, NativeChatMarkdown.tsx, CommentMarkdownWords.tsx, comment-markdown-word-fade.ts).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Markdown, { type Components, type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  linkNativeChatFilePaths,
  rewriteFileDestinationLinks,
  type FileLinkExists,
  type MarkdownAstNode,
} from '../../lib/shared/native-chat/native-chat-file-link-tree';
import type { NativeChatFileLinkSnapshot } from '../../lib/shared/native-chat/native-chat-file-link-existence';
import { routeNativeChatHref } from '../../lib/shared/native-chat/native-chat-href-routing';
import { markdownWordTokens } from '../../lib/shared/native-chat/native-chat-text-reveal';
import { CodeBlock } from './SessionCode';
import { openSessionTarget, useAgentSession } from './session-context';

const WORD_FADE_SETTLE_MS = 300;
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Elements whose renderers read their text directly or fade as one unit. */
const UNSPLIT_TAGS = new Set(['a', 'code', 'pre', 'kbd', 'svg', 'math']);

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function splitWordFadeTree(node: HastNode): void {
  if (!node.children) return;
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index]!;
    if (child.type === 'text') {
      // Skip whitespace-only text nodes (newlines between block/table/list elements) so we never insert invalid <span> siblings.
      if (!(child.value ?? '').trim()) continue;
      node.children[index] = {
        type: 'element',
        tagName: 'span',
        properties: { dataWordGroup: '' },
        children: [{ type: 'text', value: child.value ?? '' }],
      };
    } else if (child.type === 'element' && child.tagName && !UNSPLIT_TAGS.has(child.tagName)) {
      splitWordFadeTree(child);
    }
  }
}

function rehypeWordFade(): (tree: HastNode) => void {
  return splitWordFadeTree;
}

function remarkFileDestinations(): (tree: MarkdownAstNode) => void {
  return rewriteFileDestinationLinks;
}

function createRemarkWorkspaceFileLinks(exists: FileLinkExists): () => (tree: MarkdownAstNode) => void {
  return () => (tree: MarkdownAstNode) => {
    linkNativeChatFilePaths(tree, exists);
  };
}

// Keep double-tilde strikethrough only so numeric ranges like `1~2` stay plain text.
const BASE_REMARK_PLUGINS: NonNullable<Options['remarkPlugins']> = [
  [remarkGfm, { singleTilde: false }],
  remarkFileDestinations,
];

const WORD_FADE_REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [rehypeWordFade];

type FadeArrival = { end: number; at: number };
type FadeWindow = { text: string; arrivals: FadeArrival[] };

/** One settle clock per text node; settled words collapse into a plain text prefix without breaking text selection. */
const SessionMarkdownWords = memo(function SessionMarkdownWords({
  node,
  children,
  ...props
}: ComponentProps<'span'> & ExtraProps) {
  const isWordGroup = node?.properties?.dataWordGroup !== undefined;
  const text = isWordGroup ? String(children ?? '') : '';
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const [initial] = useState<FadeWindow>(() => ({
    text,
    arrivals: [{ end: text.length, at: nowMs() }],
  }));
  const groupRef = useRef<HTMLSpanElement>(null);
  const fadeWindow = useRef(initial);
  const [settled, setSettled] = useState(0);

  useIsomorphicLayoutEffect(() => {
    if (!isWordGroup || typeof document === 'undefined') return;
    const current = fadeWindow.current;
    if (current.text !== text) {
      if (!text.startsWith(current.text)) {
        current.arrivals = [];
        setSettled(0);
      }
      current.text = text;
      current.arrivals.push({ end: text.length, at: nowMs() });
    }
    let timer = 0;
    const isSelected = (): boolean => {
      const selection = document.getSelection();
      const group = groupRef.current;
      return Boolean(
        group &&
        selection &&
        !selection.isCollapsed &&
        (group.contains(selection.anchorNode) ||
          group.contains(selection.focusNode) ||
          selection.containsNode(group, true)),
      );
    };
    const schedule = (): void => {
      const first = current.arrivals[0];
      if (!first) {
        document.removeEventListener('selectionchange', onSelectionChange);
        return;
      }
      timer = window.setTimeout(() => {
        if (isSelected()) return;
        const now = nowMs();
        let end = 0;
        current.arrivals = current.arrivals.filter((arrival) => {
          if (arrival.at + WORD_FADE_SETTLE_MS > now) return true;
          end = Math.max(end, arrival.end);
          return false;
        });
        if (end > 0) setSettled(end);
        schedule();
      }, Math.max(0, first.at + WORD_FADE_SETTLE_MS - nowMs()));
    };
    const onSelectionChange = (): void => {
      window.clearTimeout(timer);
      if (!isSelected()) schedule();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    schedule();
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [text, isWordGroup]);

  if (!isWordGroup) {
    return <span {...props}>{children}</span>;
  }
  return (
    <span ref={groupRef} data-word-group="">
      {text.slice(0, settled)}
      {markdownWordTokens(text.slice(settled)).map(({ value, offset }) =>
        value.trim() === '' ? (
          value
        ) : (
          <span key={settled + offset} data-word="">
            {value}
          </span>
        ),
      )}
    </span>
  );
});

/** Arm opacity fade one frame after streaming starts so already-rendered words never flash. */
function useWordFadeArmed(fadeWords: boolean): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!fadeWords || typeof requestAnimationFrame !== 'function') {
      setArmed(false);
      return;
    }
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, [fadeWords]);
  return armed && fadeWords;
}

const noopSubscribe = () => () => {};
const getNullSnapshot = (): NativeChatFileLinkSnapshot | null => null;

function useWorkspaceFileLinkExists(
  enabled: boolean,
  streaming: boolean,
  explicit?: FileLinkExists,
): FileLinkExists | undefined {
  const { fileLinkExistence } = useAgentSession();
  const watcher = useMemo(
    () => (enabled && !explicit && fileLinkExistence ? fileLinkExistence.watch() : null),
    [enabled, explicit, fileLinkExistence],
  );
  const snapshot = useSyncExternalStore(
    watcher?.subscribe ?? noopSubscribe,
    watcher?.getSnapshot ?? getNullSnapshot,
    getNullSnapshot,
  );
  if (explicit) return explicit;
  if (!snapshot) return undefined;
  // Streaming text can end mid-path: use known answers only until the message settles.
  return streaming ? snapshot.peek : snapshot.check;
}

/** Target handed to the main process, or null when the href is not something we open. */
function linkTarget(href: string | undefined): { target: string; isFile: boolean } | null {
  const route = routeNativeChatHref(href);
  if (route.kind === 'web') return { target: route.url, isFile: false };
  if (route.kind === 'file') {
    return {
      target: route.line ? `${route.pathText}:${route.line}` : route.pathText,
      isFile: true,
    };
  }
  return null;
}

/** Hrefs are kept only as data: every link is opened through IPC and never navigates the window. */
const keepRoutableHref = (url: string): string => (linkTarget(url) ? url : '');

function SessionLink({ href, children }: { href?: string; children?: ReactNode }) {
  const session = useAgentSession();
  const resolved = linkTarget(href);
  if (!resolved) return <span className="asv-md-deadlink">{children}</span>;
  const open = () => void openSessionTarget(resolved.target, session);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };
  return (
    <a
      className="asv-md-link"
      data-file-link={resolved.isFile ? 'true' : undefined}
      role="link"
      tabIndex={0}
      title={resolved.target}
      onClick={open}
      onKeyDown={onKeyDown}
    >
      {children}
    </a>
  );
}

function createMarkdownComponents(options: {
  rowKey?: string;
  plainCode: boolean;
  fadeWords: boolean;
}): Components {
  const { rowKey, plainCode, fadeWords } = options;
  return {
    a: ({ href, children }) => <SessionLink href={href}>{children}</SessionLink>,
    // Remote images would fetch on render, so they are shown as a link to open on request.
    img: ({ src, alt }) => (
      <SessionLink href={typeof src === 'string' ? src : undefined}>{alt || '图片'}</SessionLink>
    ),
    table: ({ children }) => (
      <div className="asv-md-table">
        <table>{children}</table>
      </div>
    ),
    pre: ({ node, children }) => {
      const child = Children.toArray(children)[0];
      if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        return <pre>{children}</pre>;
      }
      const info = /language-(\S+)/.exec(child.props.className ?? '')?.[1] ?? '';
      const line = node?.position?.start?.line;
      const disclosureKey = rowKey && line !== undefined ? `code-wrap:${rowKey}:${line}` : undefined;
      return (
        <CodeBlock
          info={info}
          code={String(child.props.children ?? '').replace(/\n$/, '')}
          disclosureKey={disclosureKey}
          plain={plainCode}
        />
      );
    },
    ...(fadeWords ? { span: SessionMarkdownWords } : {}),
  };
}

/**
 * Agent and task text as GitHub-flavoured Markdown. Raw HTML in the source is never parsed: it
 * is shown as literal text, so model output can only ever produce Markdown's own elements.
 */
export const SessionMarkdown = memo(function SessionMarkdown({
  text,
  variant = 'prose',
  streaming = false,
  fadeWords = false,
  linkifyFilePaths = false,
  fileLinkExists: explicitFileLinkExists,
  rowKey,
}: {
  text: string;
  variant?: 'prose' | 'bubble' | 'muted';
  streaming?: boolean;
  fadeWords?: boolean;
  /** Detect workspace file references in plain text & inline code and turn verified paths into links. */
  linkifyFilePaths?: boolean;
  /** Optional override for workspace file-existence lookup (used in unit tests). */
  fileLinkExists?: FileLinkExists;
  /** Stable row identity so code-block wrap choices outlive unmount/fold cycles. */
  rowKey?: string;
}) {
  const wordFadeArmed = useWordFadeArmed(fadeWords);
  const resolvedExists = useWorkspaceFileLinkExists(
    linkifyFilePaths,
    streaming,
    explicitFileLinkExists,
  );
  const remarkPlugins = useMemo<NonNullable<Options['remarkPlugins']>>(
    () =>
      resolvedExists
        ? [...BASE_REMARK_PLUGINS, createRemarkWorkspaceFileLinks(resolvedExists)]
        : BASE_REMARK_PLUGINS,
    [resolvedExists],
  );
  const components = useMemo(
    () =>
      createMarkdownComponents({
        rowKey,
        plainCode: variant === 'muted',
        fadeWords,
      }),
    [rowKey, variant, fadeWords],
  );

  return (
    <div
      className={`asv-md is-${variant}`}
      data-streaming={streaming || undefined}
      data-word-fade={wordFadeArmed ? '' : undefined}
      data-block-fade={wordFadeArmed && streaming ? '' : undefined}
    >
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={fadeWords ? WORD_FADE_REHYPE_PLUGINS : undefined}
        components={components}
        urlTransform={keepRoutableHref}
      >
        {text}
      </Markdown>
    </div>
  );
});
