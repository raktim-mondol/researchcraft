import { describe, expect, it } from "vitest";
import { ImageGenerateParams } from "../src/agent/image-generate-tool.ts";
import { imageGenerateChildTool } from "../pi-packages/kady-image-generate/index.ts";

describe("kady-image-generate package parity", () => {
  it("uses the same tool name as the lead tool", () => {
    expect(imageGenerateChildTool.name).toBe("image_generate");
  });

  it("declares the same required params (prompt, path)", () => {
    // TypeBox object schemas expose required keys via properties
    const leadProps = ImageGenerateParams.properties as Record<string, unknown>;
    const childProps = (imageGenerateChildTool.parameters as { properties?: Record<string, unknown> })
      .properties;
    expect(leadProps).toBeTruthy();
    expect(childProps).toBeTruthy();
    for (const key of ["prompt", "path", "provider", "model", "size", "aspect_ratio", "quality", "reference_paths", "n"]) {
      expect(leadProps[key], `lead missing ${key}`).toBeTruthy();
      expect(childProps![key], `child missing ${key}`).toBeTruthy();
    }
  });
});
