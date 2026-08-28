import { describe, expect, test } from "bun:test";
import { validWindowAddress } from "./window-preview";

describe("blurred window previews", () => {
  test("accepts only exact Hyprland hexadecimal addresses", () => {
    expect(validWindowAddress("0xAbC123")).toBe("0xabc123");
    expect(validWindowAddress("title:anything")).toBeNull();
    expect(validWindowAddress("0x123; grim /tmp/leak")).toBeNull();
    expect(validWindowAddress("")).toBeNull();
  });
});
