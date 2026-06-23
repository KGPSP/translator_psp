import type { LanguageCode, LanguageOption } from "./config";
import type { Segment } from "./types";

function lineFor(text: string | undefined) {
  return text?.trim() ? text.trim() : "_Brak tekstu._";
}

function titleDate(date: string) {
  return new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(new Date(date));
}

export function renderOriginalMarkdown(
  sessionId: string,
  createdAt: string,
  segments: Segment[],
  languageLabels: Record<LanguageCode, LanguageOption>
) {
  const lines = [
    `# Transkrypcja oryginalna`,
    ``,
    `Sesja: \`${sessionId}\``,
    `Start: ${titleDate(createdAt)}`,
    ``
  ];

  for (const segment of segments.filter((item) => item.status === "done" || item.status === "writing")) {
    const language = segment.detectedLanguage
      ? languageLabels[segment.detectedLanguage]?.label ?? segment.detectedLanguage.toUpperCase()
      : "Nieznany";
    lines.push(`## ${segment.displayTime} - ${language}`, "", lineFor(segment.originalText), "");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function renderTranslatedMarkdown(
  sessionId: string,
  createdAt: string,
  targetLanguage: LanguageCode,
  segments: Segment[],
  languageLabels: Record<LanguageCode, LanguageOption>
) {
  const targetLabel = languageLabels[targetLanguage]?.label ?? targetLanguage.toUpperCase();
  const lines = [
    `# Rozmowa po ${targetLabel}`,
    ``,
    `Sesja: \`${sessionId}\``,
    `Start: ${titleDate(createdAt)}`,
    ``
  ];

  for (const segment of segments.filter((item) => item.status === "done" || item.status === "writing")) {
    const text = segment.translations[targetLanguage];
    lines.push(`## ${segment.displayTime}`, "", lineFor(text), "");
  }

  return `${lines.join("\n").trim()}\n`;
}
