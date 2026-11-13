import { describe, expect, it } from "vitest";
import { noteDraftStatus } from "../index";

describe("noteDraftStatus", () => {
  it("counts characters against the limit, with thousands separators", () => {
    expect(noteDraftStatus("x".repeat(1234), "").counter).toBe("1,234 / 2,000");
  });

  it("lets the Student save a new draft", () => {
    expect(noteDraftStatus("Generics are neat", "")).toEqual({
      counter: "17 / 2,000",
      tooLong: false,
      canSave: true,
      unsaved: true,
    });
  });

  it("has nothing to save when the draft matches the saved note", () => {
    const status = noteDraftStatus("Same", "Same");
    expect(status.unsaved).toBe(false);
    expect(status.canSave).toBe(false);
  });

  it("does not save a draft blanked out from a saved note", () => {
    const status = noteDraftStatus("   ", "Old thought");
    expect(status.unsaved).toBe(true);
    expect(status.canSave).toBe(false);
  });

  it("allows exactly the limit", () => {
    const status = noteDraftStatus("x".repeat(2000), "");
    expect(status.tooLong).toBe(false);
    expect(status.canSave).toBe(true);
  });

  it("flags a draft one character over the limit and refuses to save it", () => {
    const status = noteDraftStatus("x".repeat(2001), "");
    expect(status.tooLong).toBe(true);
    expect(status.canSave).toBe(false);
  });

  it("ignores whitespace at the ends, which the server trims on save", () => {
    const status = noteDraftStatus("Same\n", "Same");
    expect(status.unsaved).toBe(false);
    expect(status.canSave).toBe(false);
  });
});
