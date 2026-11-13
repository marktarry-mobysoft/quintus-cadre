import { draftStatus } from "./lib/draft";

export type { NoteDraftStatus } from "./lib/draft";

/**
 * What the note editor shows for a draft: the character counter, whether
 * it is over the limit, whether it has unsaved changes, and whether Save
 * should be enabled.
 */
export function noteDraftStatus(draft: string, saved: string) {
  return draftStatus(draft, saved);
}
