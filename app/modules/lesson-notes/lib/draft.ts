import { MAX_NOTE_LENGTH } from "~/lib/notes";

export type NoteDraftStatus = {
  /** "1,234 / 2,000", for the counter under the textarea. */
  counter: string;
  tooLong: boolean;
  canSave: boolean;
  /** The draft differs from what is saved, so leaving loses it. */
  unsaved: boolean;
};

export function draftStatus(draft: string, saved: string): NoteDraftStatus {
  const tooLong = draft.length > MAX_NOTE_LENGTH;
  const empty = draft.trim().length === 0;
  // The server trims a note before saving it, so whitespace at the ends is
  // not a change.
  const unsaved = draft.trim() !== saved;

  return {
    counter: `${draft.length.toLocaleString("en")} / ${MAX_NOTE_LENGTH.toLocaleString("en")}`,
    tooLong,
    canSave: unsaved && !empty && !tooLong,
    unsaved,
  };
}
