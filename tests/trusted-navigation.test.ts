import { describe, expect, it } from "vitest";
import { isTrustedAppNavigation } from "../src/main/services/trusted-navigation";

describe("Electron renderer navigation boundary", () => {
  it("permits the packaged application entrypoint and fragment changes", () => {
    const entry = "file:///C:/Program%20Files/SceneryWalker/dist/index.html";
    expect(isTrustedAppNavigation(entry, entry, false)).toBe(true);
    expect(isTrustedAppNavigation(entry + "#settings", entry, false)).toBe(true);
  });
  it("rejects other local files, external sites, and unexpected file hosts", () => {
    const entry = "file:///C:/App/dist/index.html";
    for (const target of [
      "https://example.com/",
      "file:///C:/Users/Public/evil.html",
      "file://evil/C:/App/dist/index.html",
      "javascript:alert(1)",
      "data:text/html,hi",
      "not-a-url",
    ])
      expect(isTrustedAppNavigation(target, entry, false)).toBe(false);
  });
  it("limits dev navigation to the explicitly configured dev origin", () => {
    const entry = "http://127.0.0.1:5173/";
    expect(isTrustedAppNavigation("http://127.0.0.1:5173/subpage", entry, true)).toBe(true);
    expect(isTrustedAppNavigation("http://localhost:5173/", entry, true)).toBe(false);
    expect(isTrustedAppNavigation("https://example.com/", entry, true)).toBe(false);
  });
});
