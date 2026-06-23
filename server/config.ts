import { homedir } from "node:os";
import path from "node:path";

export type LanguageCode =
  | "pl"
  | "en"
  | "de"
  | "es"
  | "fr"
  | "it"
  | "pt"
  | "nl"
  | "cs"
  | "hu"
  | "tr"
  | "uk"
  | "ru"
  | "ar"
  | "zh"
  | "ja"
  | "ko"
  | "hi"
  | "vi"
  | "th"
  | "id"
  | "ms"
  | "tl"
  | "fa"
  | "he";

export type LanguageOption = {
  code: LanguageCode;
  label: string;
  englishName: string;
  whisperAliases: string[];
  ttsCode?: string;
};

export const languages: LanguageOption[] = [
  { code: "pl", label: "Polski", englishName: "Polish", whisperAliases: ["pl", "polish"], ttsCode: "pl" },
  { code: "en", label: "English", englishName: "English", whisperAliases: ["en", "english"], ttsCode: "en" },
  { code: "de", label: "Deutsch", englishName: "German", whisperAliases: ["de", "german"], ttsCode: "de" },
  { code: "es", label: "Español", englishName: "Spanish", whisperAliases: ["es", "spanish", "castilian"], ttsCode: "es" },
  { code: "fr", label: "Français", englishName: "French", whisperAliases: ["fr", "french"], ttsCode: "fr" },
  { code: "it", label: "Italiano", englishName: "Italian", whisperAliases: ["it", "italian"], ttsCode: "it" },
  { code: "pt", label: "Português", englishName: "Portuguese", whisperAliases: ["pt", "portuguese"], ttsCode: "pt" },
  { code: "nl", label: "Nederlands", englishName: "Dutch", whisperAliases: ["nl", "dutch", "flemish"], ttsCode: "nl" },
  { code: "cs", label: "Čeština", englishName: "Czech", whisperAliases: ["cs", "czech"], ttsCode: "cs" },
  { code: "hu", label: "Magyar", englishName: "Hungarian", whisperAliases: ["hu", "hungarian"], ttsCode: "hu" },
  { code: "tr", label: "Türkçe", englishName: "Turkish", whisperAliases: ["tr", "turkish"], ttsCode: "tr" },
  { code: "uk", label: "Українська", englishName: "Ukrainian", whisperAliases: ["uk", "ukrainian"] },
  { code: "ru", label: "Русский", englishName: "Russian", whisperAliases: ["ru", "russian"], ttsCode: "ru" },
  { code: "ar", label: "العربية", englishName: "Arabic", whisperAliases: ["ar", "arabic"], ttsCode: "ar" },
  { code: "zh", label: "中文", englishName: "Chinese", whisperAliases: ["zh", "chinese", "mandarin"], ttsCode: "zh-cn" },
  { code: "ja", label: "日本語", englishName: "Japanese", whisperAliases: ["ja", "japanese"], ttsCode: "ja" },
  { code: "ko", label: "한국어", englishName: "Korean", whisperAliases: ["ko", "korean"], ttsCode: "ko" },
  { code: "hi", label: "हिन्दी", englishName: "Hindi", whisperAliases: ["hi", "hindi"], ttsCode: "hi" },
  { code: "vi", label: "Tiếng Việt", englishName: "Vietnamese", whisperAliases: ["vi", "vietnamese"] },
  { code: "th", label: "ไทย", englishName: "Thai", whisperAliases: ["th", "thai"] },
  { code: "id", label: "Bahasa Indonesia", englishName: "Indonesian", whisperAliases: ["id", "indonesian"] },
  { code: "ms", label: "Bahasa Melayu", englishName: "Malay", whisperAliases: ["ms", "malay"] },
  { code: "tl", label: "Filipino / Tagalog", englishName: "Tagalog", whisperAliases: ["tl", "tagalog"] },
  { code: "fa", label: "فارسی", englishName: "Persian", whisperAliases: ["fa", "persian"] },
  { code: "he", label: "עברית", englishName: "Hebrew", whisperAliases: ["he", "hebrew"] }
];

export const appConfig = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "127.0.0.1",
  idleTimeoutSeconds: Number(process.env.IDLE_TIMEOUT_SECONDS ?? 255),
  maxAudioBytes: Number(process.env.MAX_AUDIO_BYTES ?? 200 * 1024 * 1024),
  segmentSeconds: Number(process.env.SEGMENT_SECONDS ?? 600),
  sessionsDir: path.resolve(process.env.SESSIONS_DIR ?? "sessions"),
  distDir: path.resolve("dist"),
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  ollamaModel:
    process.env.OLLAMA_MODEL ?? "hf.co/mradermacher/translategemma-4b-it-GGUF:Q4_K_M",
  whisperPath:
    process.env.WHISPER_PATH ??
    path.join(homedir(), "audio-ai/whisper-mlx/.venv/bin/mlx_whisper"),
  whisperModel: process.env.WHISPER_MODEL ?? "mlx-community/whisper-large-v3-mlx",
  xttsPython: process.env.XTTS_PYTHON ?? path.join(homedir(), "audio-ai/xtts/.venv/bin/python"),
  xttsPath: process.env.XTTS_PATH ?? path.join(homedir(), "audio-ai/xtts/.venv/bin/tts"),
  xttsModel: process.env.XTTS_MODEL ?? "tts_models/multilingual/multi-dataset/xtts_v2",
  xttsTimeoutMs: Number(process.env.XTTS_TIMEOUT_MS ?? 900_000),
  xttsWorkerEnabled: ["1", "true", "yes"].includes((process.env.XTTS_WORKER_ENABLED ?? "").toLowerCase()),
  xttsWorkerUrl: process.env.XTTS_WORKER_URL ?? "http://127.0.0.1:8765",
  xttsWorkerTimeoutMs: Number(process.env.XTTS_WORKER_TIMEOUT_MS ?? process.env.XTTS_TIMEOUT_MS ?? 900_000),
  xttsDevice: process.env.XTTS_DEVICE ?? "auto"
};

export function getLanguage(code: string): LanguageOption | undefined {
  return languages.find((language) => language.code === code);
}

export function resolveDetectedLanguage(raw: string | undefined, fallback: LanguageCode): LanguageCode {
  const normalized = (raw ?? "").trim().toLowerCase();
  const match = languages.find((language) => language.whisperAliases.includes(normalized));
  return match?.code ?? fallback;
}
