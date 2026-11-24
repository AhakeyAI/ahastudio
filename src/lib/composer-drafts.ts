import type { AgentTurnAttachment } from '../types';

/** A file already saved for the session, waiting to go out with the next message. */
export interface ComposerDraftAttachment {
  key: string;
  kind: 'image' | 'file';
  name: string;
  /** Object URL of an image preview; released when the attachment leaves the draft. */
  previewUrl: string | null;
  attachment: Extract<AgentTurnAttachment, { type: 'localImage' | 'file' }>;
}

export interface ComposerDraft {
  text: string;
  attachments: ComposerDraftAttachment[];
  /** `/clear` is waiting: the next message opens a new Codex thread. */
  freshContext?: boolean;
}

const STORAGE_PREFIX = 'aha.composer-draft:';
const drafts = new Map<string, ComposerDraft>();

const storage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/**
 * Drafts per session, kept outside the view so switching tabs does not lose them. The text is
 * also saved locally and comes back after a restart; attachments and a waiting `/clear` live for
 * this run of the app.
 */
export const composerDrafts = {
  get(key: string): ComposerDraft {
    const cached = drafts.get(key);
    if (cached) return cached;
    const draft = { text: storage()?.getItem(STORAGE_PREFIX + key) ?? '', attachments: [] };
    drafts.set(key, draft);
    return draft;
  },
  /** Updates only the given fields, so the view and the composer can each keep their own part. */
  set(key: string, patch: Partial<ComposerDraft>): void {
    const draft = { ...composerDrafts.get(key), ...patch };
    drafts.set(key, draft);
    if (patch.text === undefined) return;
    const store = storage();
    if (!store) return;
    try {
      if (draft.text) store.setItem(STORAGE_PREFIX + key, draft.text);
      else store.removeItem(STORAGE_PREFIX + key);
    } catch {
      // Storage is full or unavailable; the draft still lives in memory.
    }
  },
};
