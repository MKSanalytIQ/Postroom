// Geometry for the small inline SVG line chart used on report pages. Pure, so it can be tested without rendering.

export type ChartSeries = { key: string; label: string; color: string; values: number[] };

export type Chart = {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  max: number;
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
  lines: { key: string; label: string; color: string; points: string; dots: { x: number; y: number; value: number; label: string }[] }[];
};

/** Rounds up to 1, 2 or 5 times a power of ten, and to an even number from 2 up, so the middle tick is whole. */
export function niceMax(value: number): number {
  const target = Math.max(1, value);
  const power = 10 ** Math.floor(Math.log10(target));
  const fraction = target / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  const top = nice * power;
  return top > 1 && top % 2 === 1 ? top + 1 : top;
}

export function buildChart(labels: string[], series: ChartSeries[], width = 720, height = 260): Chart {
  const plot = { left: 44, right: width - 16, top: 12, bottom: height - 34 };
  const peak = Math.max(0, ...series.flatMap((item) => item.values));
  const max = niceMax(peak);
  const count = labels.length;
  const xAt = (index: number) => (count <= 1 ? (plot.left + plot.right) / 2 : plot.left + ((plot.right - plot.left) * index) / (count - 1));
  const yAt = (value: number) => plot.bottom - ((plot.bottom - plot.top) * value) / max;
  const round = (n: number) => Math.round(n * 10) / 10;
  const middle = max / 2;
  const xIndexes = count <= 1 ? [0] : count < 5 ? [0, count - 1] : [0, Math.floor((count - 1) / 2), count - 1];
  return {
    width,
    height,
    plot,
    max,
    yTicks: [0, ...(max > 1 ? [middle] : []), max].map((value) => ({ y: round(yAt(value)), label: String(value) })),
    xTicks: [...new Set(xIndexes)].filter((index) => index < count).map((index) => ({ x: round(xAt(index)), label: labels[index] })),
    lines: series.map((item) => ({
      key: item.key,
      label: item.label,
      color: item.color,
      points: item.values.map((value, index) => `${round(xAt(index))},${round(yAt(value))}`).join(" "),
      dots: item.values.map((value, index) => ({ x: round(xAt(index)), y: round(yAt(value)), value, label: labels[index] })),
    })),
  };
}
