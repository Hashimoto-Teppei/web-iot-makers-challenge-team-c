import { describe, expect, it } from "vitest";
import type { Warning } from "../detect/types";
import { WarnGate, warnGateDefaults } from "./warn-gate";

const warn = (over: Partial<Warning> = {}): Warning => ({
  kind: "approach",
  lv: 2,
  causeId: "b2000002",
  ...over,
});

describe("WarnGate", () => {
  it("初めて見た警告は通す", () => {
    const gate = new WarnGate();
    expect(gate.admit([warn()], 1_000)).toEqual([warn()]);
  });

  it("同じ警告は再送間隔のあいだ通さない", () => {
    const gate = new WarnGate();
    gate.admit([warn()], 1_000);

    // 毎周期発火し続けても書き直さない（書くとブザーが鳴りっぱなしになる）。
    expect(gate.admit([warn()], 2_000)).toEqual([]);
    expect(gate.admit([warn()], 2_999)).toEqual([]);
  });

  it("再送間隔が過ぎたら通す（危険が続いていることを伝えるのはスマホの責務）", () => {
    const gate = new WarnGate();
    gate.admit([warn()], 1_000);
    expect(gate.admit([warn()], 3_000)).toEqual([warn()]);
  });

  it("通さなかった周期があっても、再送間隔は前に書いた時刻から測る", () => {
    const gate = new WarnGate();
    gate.admit([warn()], 1_000);
    // 間に何度落としても、基準が伸びない。伸ばすと危険が続く限り二度と再送されない。
    gate.admit([warn()], 1_500);
    gate.admit([warn()], 2_500);
    expect(gate.admit([warn()], 3_000)).toEqual([warn()]);
  });

  it("`lv` が上がったら間隔を待たずに通す", () => {
    const gate = new WarnGate();
    gate.admit([warn({ lv: 1 })], 1_000);
    expect(gate.admit([warn({ lv: 3 })], 1_100)).toEqual([warn({ lv: 3 })]);
  });

  it("`lv` が下がったときは間隔を待つ（急いで伝える理由が無い）", () => {
    const gate = new WarnGate();
    gate.admit([warn({ lv: 3 })], 1_000);
    expect(gate.admit([warn({ lv: 1 })], 1_100)).toEqual([]);
  });

  it("`causeId` が違えば別の警告として通す（別の相手である）", () => {
    const gate = new WarnGate();
    gate.admit([warn({ causeId: "b2000002" })], 1_000);
    expect(gate.admit([warn({ causeId: "c3000003" })], 1_100)).toEqual([
      warn({ causeId: "c3000003" }),
    ]);
  });

  it("`causeId` が同じでも `kind` が違えば別の警告として扱う", () => {
    // 標識の id と自転車の id が同じ項目に入るので、ID だけで突き合わせると
    // たまたま一致した別物が同じ警告として抑制される。
    const gate = new WarnGate();
    gate.admit([warn({ kind: "approach", causeId: "same-id" })], 1_000);
    expect(gate.admit([warn({ kind: "stop", causeId: "same-id" })], 1_100)).toEqual([
      warn({ kind: "stop", causeId: "same-id" }),
    ]);
  });

  it("`causeId` が無い警告も、その `kind` で1つとして抑制する", () => {
    const gate = new WarnGate();
    const noCause: Warning = { kind: "corner", lv: 1 };
    expect(gate.admit([noCause], 1_000)).toEqual([noCause]);
    expect(gate.admit([noCause], 1_500)).toEqual([]);
  });

  it("`lv` の高い順に並べて返す（詰まったときに重要なものが先に届く）", () => {
    const gate = new WarnGate();
    const low = warn({ kind: "stop", lv: 1, causeId: "sign-1" });
    const high = warn({ kind: "approach", lv: 3, causeId: "b2000002" });
    expect(gate.admit([low, high], 1_000)).toEqual([high, low]);
  });

  it("長く見ていない記録は捨てる（すれ違った相手のぶん際限なく溜めない）", () => {
    const gate = new WarnGate();
    gate.admit([warn()], 1_000);
    const later = 1_000 + warnGateDefaults.forgetAfterMs + 1;
    // 捨てたあとは「初めて見た警告」として通る。忘れる時間は再送間隔より十分長いので、
    // 抑制が効くべき場面（数秒）でここが効くことはない。
    expect(gate.admit([warn()], later)).toEqual([warn()]);
  });
});
