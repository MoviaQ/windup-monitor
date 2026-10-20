import { describe, expect, it } from "vitest";
import { formatBytes, formatPercent, formatUptime, ratioPercent } from "./format";

describe("formatBytes", () => {
  it("formatuje bajty i jednostki", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toContain("KB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toContain("GB");
  });

  it("zwraca myślnik dla nieprawidłowych danych", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("formatuje procenty i myślnik dla null", () => {
    expect(formatPercent(23.4)).toContain("%");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
  });
});

describe("ratioPercent", () => {
  it("liczy udział i odrzuca nieprawidłowe dane", () => {
    expect(ratioPercent(50, 100)).toBe(50);
    expect(ratioPercent(1, 0)).toBeNull();
    expect(ratioPercent(-5, 100)).toBeNull();
  });
});

describe("formatUptime", () => {
  it("formatuje czas działania", () => {
    expect(formatUptime(90)).toBe("1 min");
    expect(formatUptime(3700)).toContain("godz.");
    expect(formatUptime(90000)).toContain("d");
    expect(formatUptime(null)).toBe("—");
  });
});
