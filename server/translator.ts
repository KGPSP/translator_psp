import { appConfig, getLanguage, type LanguageCode } from "./config";

export async function translateText(text: string, source: LanguageCode, target: LanguageCode) {
  const sourceLanguage = getLanguage(source);
  const targetLanguage = getLanguage(target);

  if (!sourceLanguage || !targetLanguage) {
    throw new Error("Nieznany kod jezyka.");
  }

  const prompt = [
    `Translate from ${sourceLanguage.englishName} to ${targetLanguage.englishName}.`,
    "Return only the translated text.",
    "Do not add explanations, labels, markdown, quotes, or alternatives.",
    "",
    text
  ].join("\n");

  const response = await fetch(`${appConfig.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: appConfig.ollamaModel,
      prompt,
      stream: false,
      options: {
        temperature: 0
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { response?: string; error?: string };
  if (payload.error) {
    throw new Error(payload.error);
  }

  return cleanupTranslation(payload.response ?? "");
}

function cleanupTranslation(value: string) {
  return value
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/i, "")
    .replace(/^["“](.*)["”]$/s, "$1")
    .trim();
}
