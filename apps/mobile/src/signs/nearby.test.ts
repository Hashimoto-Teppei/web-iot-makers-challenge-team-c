import { describe, expect, it, vi } from "vitest";
import type { StopSign } from "../detect/types";
import { createNearbySigns } from "./nearby";
import { createMemorySignStore } from "./store";

const SIGN: StopSign = { id: "s-1", lat: 34.6615, lon: 133.9348, approach: null };
const NEXT_CELL_SIGN: StopSign = { id: "s-2", lat: 34.6705, lon: 133.9348, approach: null };

function spyStore() {
  const inner = createMemorySignStore([SIGN, NEXT_CELL_SIGN]);
  return { near: vi.fn(inner.near), meta: inner.meta };
}

describe("createNearbySigns", () => {
  it("同じセルの間は引き直さない", () => {
    const store = spyStore();
    const nearby = createNearbySigns(store);

    nearby.at(34.6612, 133.9345);
    nearby.at(34.6613, 133.9346);
    nearby.at(34.6619, 133.9349);

    // 1Hz で回っても、セルの中にいる限り SQL は1回きり。
    expect(store.near).toHaveBeenCalledTimes(1);
  });

  it("セルをまたいだら引き直す", () => {
    const store = spyStore();
    const nearby = createNearbySigns(store);

    const before = nearby.at(34.6612, 133.9345);
    const after = nearby.at(34.6705, 133.9345);

    expect(store.near).toHaveBeenCalledTimes(2);
    expect(before.map((s) => s.id)).toEqual(["s-1"]);
    expect(after.map((s) => s.id)).toEqual(["s-2"]);
  });

  it("同じセルの間は同じ配列を返す", () => {
    const nearby = createNearbySigns(spyStore());
    expect(nearby.at(34.6612, 133.9345)).toBe(nearby.at(34.6614, 133.9347));
  });
});
