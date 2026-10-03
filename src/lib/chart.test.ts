import assert from "node:assert/strict";
import test from "node:test";
import { buildChart, niceMax } from "./chart";

test("niceMax rounds up to a tidy even axis maximum", () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(2), 2);
  assert.equal(niceMax(3), 6, "3 rounds up to 5, then to the even 6");
  assert.equal(niceMax(5), 6);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(11), 20);
  assert.equal(niceMax(48), 50);
  assert.equal(niceMax(51), 100);
  assert.equal(niceMax(1234), 2000);
});

test("buildChart places points inside the plot area and scales to the largest value", () => {
  const chart = buildChart(
    ["Oct 1", "Oct 2", "Oct 3"],
    [
      { key: "a", label: "A", color: "#000", values: [0, 10, 5] },
      { key: "b", label: "B", color: "#111", values: [0, 0, 0] },
    ],
    400,
    200,
  );
  assert.equal(chart.max, 10);
  assert.deepEqual(chart.yTicks.map((tick) => tick.label), ["0", "5", "10"]);
  const [a, b] = chart.lines;
  assert.equal(a.dots.length, 3);
  assert.equal(a.dots[0].x, chart.plot.left);
  assert.equal(a.dots[2].x, chart.plot.right);
  assert.equal(a.dots[1].y, chart.plot.top, "the maximum sits on the top gridline");
  assert.equal(a.dots[0].y, chart.plot.bottom, "zero sits on the baseline");
  assert.ok(b.dots.every((dot) => dot.y === chart.plot.bottom));
  assert.equal(a.points.split(" ").length, 3);
  for (const dot of a.dots) {
    assert.ok(dot.x >= chart.plot.left && dot.x <= chart.plot.right);
    assert.ok(dot.y >= chart.plot.top && dot.y <= chart.plot.bottom);
  }
  assert.deepEqual(chart.xTicks.map((tick) => tick.label), ["Oct 1", "Oct 3"]);
});

test("a single day is centred, an empty series still draws an axis, long ranges label the middle", () => {
  const single = buildChart(["Oct 1"], [{ key: "a", label: "A", color: "#000", values: [3] }], 400, 200);
  assert.equal(single.lines[0].dots[0].x, (single.plot.left + single.plot.right) / 2);
  assert.deepEqual(single.xTicks.map((tick) => tick.label), ["Oct 1"]);
  const empty = buildChart([], [{ key: "a", label: "A", color: "#000", values: [] }]);
  assert.equal(empty.max, 1);
  assert.deepEqual(empty.yTicks.map((tick) => tick.label), ["0", "1"]);
  assert.equal(empty.xTicks.length, 0);
  const labels = Array.from({ length: 9 }, (_, i) => `D${i}`);
  const long = buildChart(labels, [{ key: "a", label: "A", color: "#000", values: labels.map(() => 1) }]);
  assert.deepEqual(long.xTicks.map((tick) => tick.label), ["D0", "D4", "D8"]);
});
