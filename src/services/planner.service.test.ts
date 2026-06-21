import { test } from "node:test";
import assert from "node:assert/strict";
import { planVariants } from "./planner.service.js";

test("1080p source → 1080/720/480 ladder, highest first", () => {
  const variants = planVariants({ height: 1080 });
  assert.deepEqual(
    variants.map((v) => v.height),
    [1080, 720, 480]
  );
});

test("4K source → full ladder down to 480", () => {
  const variants = planVariants({ height: 2160 });
  assert.deepEqual(
    variants.map((v) => v.height),
    [2160, 1080, 720, 480]
  );
});

test("never upscales: a 1440p source tops out at the 1080 preset", () => {
  const variants = planVariants({ height: 1440 });
  assert.deepEqual(
    variants.map((v) => v.height),
    [1080, 720, 480]
  );
});

test("preset bitrates are applied per rung", () => {
  assert.deepEqual(planVariants({ height: 720 }), [
    { height: 720, bitrate: 2_800_000 },
    { height: 480, bitrate: 1_200_000 },
  ]);
});

test("sub-480 source → single source-height variant reusing its bitrate", () => {
  const variants = planVariants({ height: 360, bitrate: 800_000 });
  assert.equal(variants.length, 1);
  assert.equal(variants[0]?.height, 360);
  assert.equal(variants[0]?.bitrate, 800_000);
});

test("sub-480 source with no bitrate → falls back to the 480 preset", () => {
  const variants = planVariants({ height: 240 });
  assert.equal(variants.length, 1);
  assert.equal(variants[0]?.bitrate, 1_200_000);
});

test("missing height throws", () => {
  assert.throws(() => planVariants({}), /height is missing/);
});
