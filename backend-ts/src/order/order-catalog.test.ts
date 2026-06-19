// backend-ts/src/order/order-catalog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderForMeasure, ORDER_CATALOG } from "./order-catalog.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

test("every runnable (registered) measure maps to an order", () => {
  for (const id of Object.keys(MEASURES)) {
    assert.ok(orderForMeasure(id), `missing order for runnable measure ${id}`);
  }
});

test("reused terminology codes match the seed (audiogram/tb/flu)", () => {
  assert.equal(orderForMeasure("audiogram")!.code, "92557");
  assert.equal(orderForMeasure("tb_surveillance")!.code, "86580");
  assert.equal(orderForMeasure("flu_vaccine")!.code, "141");
});

test("unknown measure yields null (extension-safe)", () => {
  assert.equal(orderForMeasure("does_not_exist"), null);
});

test("catalog only covers Active or known measures (no stray ids)", () => {
  const known = new Set(MEASURE_CATALOG.map((m) => m.id));
  for (const id of Object.keys(ORDER_CATALOG)) assert.ok(known.has(id), `catalog id ${id} not in MEASURE_CATALOG`);
});
