import { describe, expect, it } from "vitest";
import { CHART_SIZE, chartGeometry, scaleTicks, type ChartDay } from "@/features/forecast/chart";

const plainDay = (date: string, closing: bigint, flags: Partial<ChartDay> = {}): ChartDay => ({
  date,
  closing,
  belowZero: false,
  belowCushion: false,
  ...flags,
});
// 300 wide and 100 high inside a 4-pixel padding, so the numbers are easy to check.
const SMALL = { width: 308, height: 108, padding: 4 };

describe("chartGeometry", () => {
  it("scales a step line between the lowest and highest of the balances, zero and the cushion", () => {
    const geometry = chartGeometry(
      [
        plainDay("2026-11-30", 10000n),
        plainDay("2026-12-01", -5000n, { belowZero: true, belowCushion: true }),
        plainDay("2026-12-02", 20000n),
      ],
      5000n,
      SMALL,
    );
    // The range is -$50 to $200 ($250 across 100 pixels), and each day is 100 pixels wide.
    expect(geometry).toEqual({
      width: 308,
      height: 108,
      path: "M4 44 H104 V104 H204 V4 H304",
      area: "M4 44 H104 V104 H204 V4 H304 V108 H4 Z",
      pastPath: null,
      todayX: null,
      zeroY: 84,
      cushionY: 64,
      bands: [{ x: 104, width: 100, kind: "below_zero" }],
      months: [{ x: 104, date: "2026-12-01" }],
      ticks: [
        { y: 104, cents: -5000n },
        { y: 84, cents: 0n },
        { y: 64, cents: 5000n },
        { y: 44, cents: 10000n },
        { y: 24, cents: 15000n },
        { y: 4, cents: 20000n },
      ],
      points: [
        { x: 54, y: 44 },
        { x: 154, y: 104 },
        { x: 254, y: 4 },
      ],
      low: -5000n,
      high: 20000n,
    });
  });

  it("joins neighbouring days of the same kind into one band", () => {
    const geometry = chartGeometry(
      [
        plainDay("2026-11-10", 100n, { belowCushion: true }),
        plainDay("2026-11-11", 100n, { belowCushion: true }),
        plainDay("2026-11-12", -100n, { belowZero: true, belowCushion: true }),
        plainDay("2026-11-13", 900n),
      ],
      500n,
      { width: 408, height: 108, padding: 4 },
    );
    expect(geometry.bands).toEqual([
      { x: 4, width: 200, kind: "below_cushion" },
      { x: 204, width: 100, kind: "below_zero" },
    ]);
  });

  it("draws a flat line at zero across a $1 range, with no cushion", () => {
    const geometry = chartGeometry([plainDay("2026-11-14", 0n)], null, SMALL);
    expect(geometry).toMatchObject({ path: "M4 104 H304", zeroY: 104, cushionY: null, low: 0n, high: 100n });
  });

  it("uses the standard size unless told otherwise", () => {
    expect(chartGeometry([plainDay("2026-11-14", 100n)], null)).toMatchObject({ width: CHART_SIZE.width, height: CHART_SIZE.height });
  });

  it("draws past days as their own line that meets the forecast, and marks where the forecast begins", () => {
    const geometry = chartGeometry(
      [plainDay("2026-11-28", 10000n, { past: true }), plainDay("2026-11-29", 20000n, { past: true }), plainDay("2026-11-30", 0n)],
      null,
      SMALL,
    );
    expect(geometry).toMatchObject({
      pastPath: "M4 54 H104 V4 H204 V104",
      path: "M204 104 H304",
      area: "M204 104 H304 V108 H204 Z",
      todayX: 204,
    });
  });
});

describe("scaleTicks", () => {
  it("picks round steps and always lands on zero when zero is in range", () => {
    expect(scaleTicks(0n, 100n)).toEqual([0n, 20n, 40n, 60n, 80n, 100n]);
    expect(scaleTicks(-12345n, 487650n)).toEqual([0n, 100000n, 200000n, 300000n, 400000n]);
    expect(scaleTicks(-30000n, 0n)).toEqual([-30000n, -20000n, -10000n, 0n]);
  });
});
