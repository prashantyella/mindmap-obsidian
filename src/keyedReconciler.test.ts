import test from "node:test";
import assert from "node:assert/strict";

import { reconcileKeyedOrder } from "./keyedReconciler";

interface FakeRow { key: string; pinControl: object }

void test("unchanged async refresh performs zero moves and preserves row/control identity, focus, and scroll", () => {
  const rows: FakeRow[] = ["A", "B", "C"].map((key) => ({ key, pinControl: {} }));
  const originalRows = [...rows];
  const focusedControl = rows[1]!.pinControl;
  let activeElement = focusedControl;
  let scrollTop = 137;
  let moves = 0;
  reconcileKeyedOrder(["A", "B", "C"], {
    first: () => rows[0] ?? null,
    next: (node) => rows[rows.indexOf(node) + 1] ?? null,
    find: (key) => rows.find((row) => row.key === key) ?? null,
    insertBefore: (node, before) => {
      moves += 1;
      rows.splice(rows.indexOf(node), 1);
      const index = before === null ? rows.length : rows.indexOf(before);
      rows.splice(index, 0, node);
      activeElement = focusedControl;
      scrollTop = 137;
    },
  });
  assert.equal(moves, 0);
  assert.deepEqual(rows, originalRows);
  assert.equal(rows[1], originalRows[1]);
  assert.equal(rows[1]!.pinControl, focusedControl);
  assert.equal(activeElement, focusedControl);
  assert.equal(scrollTop, 137);
});

void test("changed results move only out-of-order keyed rows and preserve their controls", () => {
  const rows: FakeRow[] = ["A", "B", "C"].map((key) => ({ key, pinControl: {} }));
  const controls = new Map(rows.map((row) => [row.key, row.pinControl]));
  let moves = 0;
  reconcileKeyedOrder(["C", "A", "B"], {
    first: () => rows[0] ?? null,
    next: (node) => rows[rows.indexOf(node) + 1] ?? null,
    find: (key) => rows.find((row) => row.key === key) ?? null,
    insertBefore: (node, before) => {
      moves += 1;
      rows.splice(rows.indexOf(node), 1);
      rows.splice(before === null ? rows.length : rows.indexOf(before), 0, node);
    },
  });
  assert.deepEqual(rows.map((row) => row.key), ["C", "A", "B"]);
  assert.equal(moves, 1);
  for (const row of rows) assert.equal(row.pinControl, controls.get(row.key));
});
