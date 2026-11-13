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
  // The server trims a note before saving and checks the limit on what is
  // left, so whitespace at the ends neither counts nor is a change.
  const trimmed = draft.trim();
  const tooLong = trimmed.length > MAX_NOTE_LENGTH;
  const empty = trimmed.length === 0;
  const unsaved = trimmed !== saved;

  return {
    counter: `${trimmed.length.toLocaleString("en")} / ${MAX_NOTE_LENGTH.toLocaleString("en")}`,
    tooLong,
    canSave: unsaved && !empty && !tooLong,
    unsaved,
  };
}
