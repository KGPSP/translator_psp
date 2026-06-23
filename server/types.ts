import type { LanguageCode } from "./config";

export type HealthItem = {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
};

export type SegmentStatus =
  | "queued"
  | "converting"
  | "transcribing"
  | "translating"
  | "synthesizing"
  | "writing"
  | "done"
  | "error";

export type ProcessingStep = {
  name: "Whisper" | "TranslateGemma" | "XTTS" | "Markdown";
  status: "idle" | "queued" | "active" | "ok" | "error";
  detail: string;
  latencyMs?: number;
};

export type SessionFile = {
  name: string;
  path: string;
  size: number;
  updatedAt?: string;
};

export type Segment = {
  id: string;
  createdAt: string;
  displayTime: string;
  status: SegmentStatus;
  languageA: LanguageCode;
  languageB: LanguageCode;
  detectedLanguage?: LanguageCode;
  targetLanguage?: LanguageCode;
  originalText?: string;
  translatedText?: string;
  translations: Partial<Record<LanguageCode, string>>;
  error?: string;
  audioError?: string;
  timings: Partial<Record<"convert" | "transcribe" | "translate" | "tts" | "write" | "total", number>>;
  sourcePath?: string;
  wavPath?: string;
  translationAudioPath?: string;
};

export type SessionState = {
  id: string;
  sessionNumber: number;
  createdAt: string;
  dir: string;
  languageA: LanguageCode;
  languageB: LanguageCode;
  segments: Segment[];
  files: SessionFile[];
  steps: ProcessingStep[];
};

export type ClientEvent =
  | { type: "session"; session: SessionState }
  | { type: "segment"; segment: Segment; session: SessionState }
  | { type: "steps"; steps: ProcessingStep[] }
  | { type: "health"; health: HealthItem[] }
  | { type: "error"; message: string };
