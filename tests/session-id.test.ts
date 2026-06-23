import { expect, test } from "bun:test";
import { createSessionId, nextSessionNumber } from "../server/session-id";

test("builds session folder id from date, next number and short id", () => {
  const session = createSessionId(
    new Date("2026-06-23T12:00:00.000Z"),
    ["20260622_sesja_0001_id_aaaaaaaa", "20260623_sesja_0002_id_bbbbbbbb"],
    "12345678-90ab-cdef-1234-567890abcdef"
  );

  expect(session).toEqual({
    id: "20260623_sesja_0003_id_12345678",
    sessionNumber: 3
  });
});

test("keeps numbering consecutive when older timestamp folders exist", () => {
  expect(nextSessionNumber(["20260623-115751", "20260623-120000"])).toBe(3);
  expect(nextSessionNumber(["20260623-115751", "20260623_sesja_0011_id_abcdefgh"])).toBe(12);
});
