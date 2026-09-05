import { describe, expect, it } from "vitest";
import {
  resolveWhispercppModel,
  WHISPERCPP_DEFAULT_MODEL,
  WHISPERCPP_MODEL_CHOICES,
} from "../config";

describe("resolving the local Whisper model", () => {
  it("follows the machine when the choice is automatic", () => {
    expect(resolveWhispercppModel("auto", "small")).toBe("small");
    expect(resolveWhispercppModel("auto", "tiny")).toBe("tiny");
  });

  it("honours an explicit choice over the recommendation", () => {
    // Someone who picked a size meant it, even on a machine that suits another.
    expect(resolveWhispercppModel("small", "tiny")).toBe("small");
    expect(resolveWhispercppModel("tiny", "small")).toBe("tiny");
  });

  it("falls back rather than resolving to nothing", () => {
    // The recommendation is absent until the runtime has answered once, and a
    // missing answer must not become a missing model.
    expect(resolveWhispercppModel("auto", null)).toBe(WHISPERCPP_DEFAULT_MODEL);
    expect(resolveWhispercppModel("auto", undefined)).toBe(
      WHISPERCPP_DEFAULT_MODEL,
    );
    expect(
      resolveWhispercppModel("auto", "medium" as never),
    ).toBe(WHISPERCPP_DEFAULT_MODEL);
  });

  it("always resolves to a model the runtime knows", () => {
    const models = ["tiny", "base", "small"];
    for (const choice of WHISPERCPP_MODEL_CHOICES) {
      expect(models).toContain(resolveWhispercppModel(choice, "base"));
    }
  });
});
