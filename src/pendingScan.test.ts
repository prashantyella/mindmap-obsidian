import test from "node:test";
import assert from "node:assert/strict";

import { DebouncedRefreshController } from "./pendingScan";

void test("DebouncedRefreshController collapses repeated triggers into one callback", () => {
  let callbackCount = 0;
  const handles = new Set<{ run: () => void }>();
  const controller = new DebouncedRefreshController(
    (callback) => {
      const handle = { run: callback };
      handles.add(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    (handle) => {
      handles.delete(handle as unknown as { run: () => void });
    },
    () => {
      callbackCount += 1;
    },
    100,
  );

  controller.trigger();
  controller.trigger();
  controller.trigger();

  assert.equal(handles.size, 1);
  const [handle] = [...handles];
  handle.run();

  assert.equal(callbackCount, 1);
  controller.dispose();
});
