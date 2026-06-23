import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { SessionStore } from "../server/session-store";
import type { LanguageCode } from "../server/config";
import type { Segment, SessionState } from "../server/types";

type TestStore = {
  session: SessionState;
  writeSessionFiles: () => Promise<void>;
};

type TranslationCall = {
  text: string;
  source: LanguageCode;
  target: LanguageCode;
};

test("writes complete translation pages for every language used in the session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "translation-pages-"));
  const calls: TranslationCall[] = [];
  const store = createTestStore(dir, async (text, source, target) => {
    calls.push({ text, source, target });
    return `[${source}->${target}] ${text}`;
  });

  store.session = createSession(dir, {
    languageA: "pl",
    languageB: "ru",
    segments: [
      segment("1", "12:00:00", "pl", "en", "Proszę powiedz skąd jesteś.", "Please tell me where you are from."),
      segment("2", "12:01:00", "pl", "uk", "Dziękuję.", "Дякую."),
      segment("3", "12:02:00", "pl", "ru", "Masz aktualne dokumenty?", "У вас есть актуальные документы?")
    ]
  });

  try {
    await store.writeSessionFiles();

    const english = await readFile(path.join(dir, "translated.en.md"), "utf8");
    const ukrainian = await readFile(path.join(dir, "translated.uk.md"), "utf8");
    const russian = await readFile(path.join(dir, "translated.ru.md"), "utf8");

    expect(english).toContain("Please tell me where you are from.");
    expect(english).toContain("[pl->en] Dziękuję.");
    expect(english).toContain("[pl->en] Masz aktualne dokumenty?");
    expect(english).not.toContain("_Brak tekstu._");

    expect(ukrainian).toContain("[pl->uk] Proszę powiedz skąd jesteś.");
    expect(ukrainian).toContain("Дякую.");
    expect(ukrainian).toContain("[pl->uk] Masz aktualne dokumenty?");
    expect(ukrainian).not.toContain("_Brak tekstu._");

    expect(russian).toContain("[pl->ru] Proszę powiedz skąd jesteś.");
    expect(russian).toContain("[pl->ru] Dziękuję.");
    expect(russian).toContain("У вас есть актуальные документы?");
    expect(russian).not.toContain("_Brak tekstu._");

    expect(new Set(calls.map((call) => `${call.source}->${call.target}:${call.text}`))).toEqual(new Set([
      "pl->ru:Proszę powiedz skąd jesteś.",
      "pl->uk:Proszę powiedz skąd jesteś.",
      "pl->en:Dziękuję.",
      "pl->ru:Dziękuję.",
      "pl->en:Masz aktualne dokumenty?",
      "pl->uk:Masz aktualne dokumenty?"
    ]));
    expect(calls).toHaveLength(6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses original text for the spoken language page without translating it again", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "translation-pages-"));
  const calls: TranslationCall[] = [];
  const store = createTestStore(dir, async (text, source, target) => {
    calls.push({ text, source, target });
    return `[${source}->${target}] ${text}`;
  });

  store.session = createSession(dir, {
    languageA: "pl",
    languageB: "en",
    segments: [
      {
        ...segment("1", "12:00:00", "en", "pl", "Thank you.", "Dziękuję."),
        translations: {
          pl: "Dziękuję."
        }
      }
    ]
  });

  try {
    await store.writeSessionFiles();

    const english = await readFile(path.join(dir, "translated.en.md"), "utf8");
    expect(english).toContain("Thank you.");
    expect(english).not.toContain("_Brak tekstu._");
    expect(calls).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function createTestStore(
  dir: string,
  translator: (text: string, source: LanguageCode, target: LanguageCode) => Promise<string>
) {
  const store = new (SessionStore as unknown as {
    new (
      broadcast: (event: unknown) => void,
      translator: (text: string, source: LanguageCode, target: LanguageCode) => Promise<string>
    ): SessionStore;
  })(() => undefined, translator) as unknown as TestStore;
  store.session.dir = dir;
  return store;
}

function createSession(
  dir: string,
  input: Pick<SessionState, "languageA" | "languageB" | "segments">
): SessionState {
  return {
    id: "test-session",
    sessionNumber: 1,
    createdAt: "2026-06-23T10:00:00.000Z",
    dir,
    languageA: input.languageA,
    languageB: input.languageB,
    segments: input.segments,
    files: [],
    steps: []
  };
}

function segment(
  id: string,
  displayTime: string,
  detectedLanguage: LanguageCode,
  targetLanguage: LanguageCode,
  originalText: string,
  translatedText: string
): Segment {
  return {
    id,
    createdAt: "2026-06-23T10:00:00.000Z",
    displayTime,
    status: "done",
    languageA: detectedLanguage,
    languageB: targetLanguage,
    detectedLanguage,
    targetLanguage,
    originalText,
    translatedText,
    translations: {
      [detectedLanguage]: originalText,
      [targetLanguage]: translatedText
    },
    timings: {}
  };
}
