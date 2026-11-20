import { describe, expect, it } from "vitest";
import { PICKER_PATH, PICKER_SCRIPT, withPicker } from "./picker.js";

describe("the Select script", () => {
  it("is added at the end of the body, or of the page", () => {
    expect(withPicker("<html><body><h1>Hi</h1></BODY></html>")).toBe(`<html><body><h1>Hi</h1><script src="/${PICKER_PATH}"></script></BODY></html>`);
    expect(withPicker("<h1>Hi</h1>")).toBe(`<h1>Hi</h1><script src="/${PICKER_PATH}"></script>`);
  });

  it("is valid JavaScript that only talks to the window around it", () => {
    expect(() => new Function(PICKER_SCRIPT)).not.toThrow();
    expect(PICKER_SCRIPT).toContain("e.source !== window.parent");
    expect(PICKER_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|document\.cookie/);
  });
});
