import { expect, test } from "bun:test";
import { languages, type LanguageCode } from "../server/config";
import { renderOriginalMarkdown, renderTranslatedMarkdown } from "../server/markdown";
import type { Segment } from "../server/types";

const languageLabels = Object.fromEntries(languages.map((language) => [language.code, language])) as Record<
  LanguageCode,
  (typeof languages)[number]
>;

const segments: Segment[] = [
  {
    id: "1",
    createdAt: "2026-06-23T10:00:00.000Z",
    displayTime: "12:00:00",
    status: "done",
    languageA: "pl",
    languageB: "en",
    detectedLanguage: "pl",
    targetLanguage: "en",
    originalText: "Dzien dobry.",
    translatedText: "Good morning.",
    translations: {
      pl: "Dzien dobry.",
      en: "Good morning."
    },
    timings: {}
  },
  {
    id: "2",
    createdAt: "2026-06-23T10:00:05.000Z",
    displayTime: "12:00:05",
    status: "done",
    languageA: "pl",
    languageB: "en",
    detectedLanguage: "en",
    targetLanguage: "pl",
    originalText: "Thank you.",
    translatedText: "Dziekuje.",
    translations: {
      en: "Thank you.",
      pl: "Dziekuje."
    },
    timings: {}
  }
];

test("renders original transcript in source languages", () => {
  const markdown = renderOriginalMarkdown("session-1", "2026-06-23T10:00:00.000Z", segments, languageLabels);
  expect(markdown).toContain("Dzien dobry.");
  expect(markdown).toContain("Thank you.");
  expect(markdown).toContain("Polski");
  expect(markdown).toContain("English");
});

test("renders full conversation in target language", () => {
  const polish = renderTranslatedMarkdown("session-1", "2026-06-23T10:00:00.000Z", "pl", segments, languageLabels);
  const english = renderTranslatedMarkdown("session-1", "2026-06-23T10:00:00.000Z", "en", segments, languageLabels);

  expect(polish).toContain("Dzien dobry.");
  expect(polish).toContain("Dziekuje.");
  expect(english).toContain("Good morning.");
  expect(english).toContain("Thank you.");
});
