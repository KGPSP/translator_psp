import { readdirSync } from "node:fs";
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfig, getLanguage, languages, resolveDetectedLanguage, type LanguageCode } from "./config";
import { renderOriginalMarkdown, renderTranslatedMarkdown } from "./markdown";
import { runCommand } from "./process";
import { createSessionId } from "./session-id";
import { synthesizeSpeech } from "./tts-client";
import { translateText } from "./translator";
import type { ProcessingStep, Segment, SessionFile, SessionState } from "./types";

type Broadcast = (event: unknown) => void;
type TranslationFunction = typeof translateText;

const languageLabels = Object.fromEntries(languages.map((language) => [language.code, language])) as Record<
  LanguageCode,
  (typeof languages)[number]
>;

const coreSessionFileNames = ["original.md", "segments.json"];

export class SessionStore {
  private session: SessionState;
  private queue: string[] = [];
  private active = false;

  constructor(
    private readonly broadcast: Broadcast,
    private readonly translatePageText: TranslationFunction = translateText
  ) {
    this.session = this.createSession("pl", "en");
  }

  async initialize() {
    await mkdir(appConfig.sessionsDir, { recursive: true });
    await mkdir(this.session.dir, { recursive: true });
    await mkdir(path.join(this.session.dir, "audio"), { recursive: true });
    await this.writeSessionFiles();
  }

  getSession() {
    return this.session;
  }

  async reset(languageA: LanguageCode, languageB: LanguageCode) {
    this.session = this.createSession(languageA, languageB);
    this.queue = [];
    this.active = false;
    await this.initialize();
    this.broadcast({ type: "session", session: this.session });
    return this.session;
  }

  async acceptAudio(input: {
    file: File;
    languageA: LanguageCode;
    languageB: LanguageCode;
    mimeType: string;
  }) {
    if (!getLanguage(input.languageA) || !getLanguage(input.languageB)) {
      throw new Error("Nieobslugiwany jezyk.");
    }
    if (input.languageA === input.languageB) {
      throw new Error("Wybierz dwa rozne jezyki.");
    }
    if (input.file.size <= 0) {
      throw new Error("Pusty segment audio.");
    }
    if (input.file.size > appConfig.maxAudioBytes) {
      throw new Error("Segment audio jest za duzy.");
    }
    if (!isAllowedAudio(input.mimeType)) {
      throw new Error(`Nieobslugiwany format audio: ${input.mimeType || "unknown"}.`);
    }

    this.session.languageA = input.languageA;
    this.session.languageB = input.languageB;

    const now = new Date();
    const segment: Segment = {
      id: crypto.randomUUID(),
      createdAt: now.toISOString(),
      displayTime: now.toLocaleTimeString("pl-PL", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }),
      status: "queued",
      languageA: input.languageA,
      languageB: input.languageB,
      translations: {},
      timings: {}
    };

    const extension = extensionForMime(input.mimeType);
    const audioDir = path.join(this.session.dir, "audio");
    segment.sourcePath = path.join(audioDir, `${segment.id}.${extension}`);
    segment.wavPath = path.join(audioDir, `${segment.id}.wav`);
    await Bun.write(segment.sourcePath, input.file);

    this.session.segments.push(segment);
    this.queue.push(segment.id);
    await this.persistSegments();
    this.broadcast({ type: "segment", segment, session: this.session });
    this.processQueue();
    return segment;
  }

  async retrySegment(id: string) {
    const segment = this.session.segments.find((item) => item.id === id);
    if (!segment) {
      throw new Error("Nie znaleziono segmentu.");
    }
    if (!segment.sourcePath) {
      throw new Error("Segment nie ma pliku zrodlowego.");
    }
    segment.status = "queued";
    segment.error = undefined;
    segment.originalText = undefined;
    segment.translatedText = undefined;
    segment.detectedLanguage = undefined;
    segment.targetLanguage = undefined;
    segment.audioError = undefined;
    segment.translationAudioPath = undefined;
    segment.translations = {};
    segment.timings = {};
    this.queue.push(segment.id);
    await this.persistSegments();
    this.broadcast({ type: "segment", segment, session: this.session });
    this.processQueue();
    return segment;
  }

  async listFiles(): Promise<SessionFile[]> {
    await mkdir(this.session.dir, { recursive: true });
    const names = await readdir(this.session.dir);
    const files: SessionFile[] = [];
    for (const name of names.filter((item) => isSessionFileName(item))) {
      const filePath = path.join(this.session.dir, name);
      const fileStat = await stat(filePath);
      files.push({
        name,
        path: filePath,
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString()
      });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSegmentAudioPath(id: string, kind: "original" | "translation") {
    const segment = this.session.segments.find((item) => item.id === id);
    if (!segment) {
      throw new Error("Nie znaleziono segmentu.");
    }

    if (kind === "original") {
      if (!segment.wavPath || !(await Bun.file(segment.wavPath).exists())) {
        throw new Error("Oryginalny plik audio nie jest jeszcze gotowy.");
      }
      return segment.wavPath;
    }

    return this.ensureTranslationAudio(segment);
  }

  async retryTranslationAudio(id: string) {
    const segment = this.session.segments.find((item) => item.id === id);
    if (!segment) {
      throw new Error("Nie znaleziono segmentu.");
    }
    if (!segment.translatedText || !segment.targetLanguage) {
      throw new Error("Tlumaczenie nie jest jeszcze gotowe.");
    }

    const targetLanguage = getLanguage(segment.targetLanguage);
    if (!targetLanguage?.ttsCode) {
      segment.audioError = `XTTS nie obsluguje lokalnego odtwarzania audio dla jezyka: ${
        targetLanguage?.label ?? segment.targetLanguage
      }. Tekst tlumaczenia jest zapisany.`;
      await this.persistSegments();
      this.broadcast({ type: "segment", segment, session: this.session });
      return segment;
    }

    segment.status = "synthesizing";
    segment.audioError = undefined;
    segment.translationAudioPath = undefined;
    this.setSteps([
      step("Whisper", "ok", "Gotowe", segment.timings.transcribe),
      step("TranslateGemma", "ok", "Gotowe", segment.timings.translate),
      step("XTTS", "active", "Synteza glosu"),
      step("Markdown", "ok", "Zapisano")
    ]);
    await this.persistSegments();
    this.broadcast({ type: "segment", segment, session: this.session });
    void this.retryTranslationAudioInBackground(segment);
    return segment;
  }

  private createSession(languageA: LanguageCode, languageB: LanguageCode): SessionState {
    const createdAt = new Date();
    const { id, sessionNumber } = createSessionId(createdAt, existingSessionDirectoryNames());

    return {
      id,
      sessionNumber,
      createdAt: createdAt.toISOString(),
      dir: path.join(appConfig.sessionsDir, id),
      languageA,
      languageB,
      segments: [],
      files: [],
      steps: defaultSteps()
    };
  }

  private processQueue() {
    if (this.active) {
      return;
    }
    this.active = true;
    void this.processNext();
  }

  private async processNext() {
    while (this.queue.length > 0) {
      const id = this.queue.shift();
      const segment = this.session.segments.find((item) => item.id === id);
      if (!segment) {
        continue;
      }
      await this.processSegment(segment);
    }
    this.active = false;
    this.setSteps(defaultSteps());
  }

  private async processSegment(segment: Segment) {
    const totalStarted = performance.now();
    try {
      await this.convertAudio(segment);
      await this.transcribe(segment);
      await this.translate(segment);
      await this.synthesizeTranslation(segment);
      segment.status = "writing";
      this.broadcast({ type: "segment", segment, session: this.session });
      const writeStarted = performance.now();
      await this.writeSessionFiles(segment);
      segment.timings.write = Math.round(performance.now() - writeStarted);
      segment.status = "done";
      segment.timings.total = Math.round(performance.now() - totalStarted);
      await this.persistSegments();
      this.broadcast({ type: "segment", segment, session: this.session });
    } catch (error) {
      segment.status = "error";
      segment.error = error instanceof Error ? error.message : String(error);
      segment.timings.total = Math.round(performance.now() - totalStarted);
      await this.persistSegments();
      this.setSteps(defaultSteps("error"));
      this.broadcast({ type: "segment", segment, session: this.session });
    }
  }

  private async convertAudio(segment: Segment) {
    if (!segment.sourcePath || !segment.wavPath) {
      throw new Error("Brak sciezek audio segmentu.");
    }

    segment.status = "converting";
    this.setSteps([
      step("Whisper", "active", "Konwersja audio"),
      step("TranslateGemma", "idle", "Czeka"),
      step("XTTS", "idle", "Czeka"),
      step("Markdown", "idle", "Czeka")
    ]);
    this.broadcast({ type: "segment", segment, session: this.session });

    const result = await runCommand(
      [
        appConfig.ffmpegPath,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        segment.sourcePath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-vn",
        segment.wavPath
      ],
      300_000
    );
    segment.timings.convert = result.durationMs;
    if (!result.ok) {
      throw new Error(result.stderr.trim() || "FFmpeg nie przekonwertowal audio.");
    }
  }

  private async transcribe(segment: Segment) {
    if (!segment.wavPath) {
      throw new Error("Brak pliku WAV segmentu.");
    }

    segment.status = "transcribing";
    this.setSteps([
      step("Whisper", "active", "Transkrypcja"),
      step("TranslateGemma", "idle", "Czeka"),
      step("XTTS", "idle", "Czeka"),
      step("Markdown", "idle", "Czeka")
    ]);
    this.broadcast({ type: "segment", segment, session: this.session });

    const outputDir = path.join(this.session.dir, "whisper");
    await mkdir(outputDir, { recursive: true });

    const result = await runCommand(
      [
        appConfig.whisperPath,
        segment.wavPath,
        "--model",
        appConfig.whisperModel,
        "--output-dir",
        outputDir,
        "--output-name",
        segment.id,
        "--output-format",
        "json",
        "--verbose",
        "False",
        "--condition-on-previous-text",
        "False"
      ],
      1_800_000
    );
    segment.timings.transcribe = result.durationMs;
    if (!result.ok) {
      throw new Error(result.stderr.trim() || "Whisper nie zwrocil transkrypcji.");
    }

    const jsonPath = path.join(outputDir, `${segment.id}.json`);
    const payload = (await Bun.file(jsonPath).json()) as {
      text?: string;
      language?: string;
      segments?: Array<{ text?: string }>;
    };

    const text =
      payload.text?.trim() ??
      payload.segments
        ?.map((item) => item.text?.trim())
        .filter(Boolean)
        .join(" ")
        .trim() ??
      "";

    if (!text) {
      throw new Error("Whisper zwrocil pusty tekst.");
    }

    segment.originalText = text;
    segment.detectedLanguage = resolveDetectedLanguage(payload.language, segment.languageA);

    if (![segment.languageA, segment.languageB].includes(segment.detectedLanguage)) {
      segment.detectedLanguage = segment.languageA;
    }

    segment.translations[segment.detectedLanguage] = text;
  }

  private async translate(segment: Segment) {
    if (!segment.originalText || !segment.detectedLanguage) {
      throw new Error("Brak tekstu lub jezyka do tlumaczenia.");
    }

    const target = segment.detectedLanguage === segment.languageA ? segment.languageB : segment.languageA;
    segment.targetLanguage = target;
    segment.status = "translating";
    this.setSteps([
      step("Whisper", "ok", "Gotowe", segment.timings.transcribe),
      step("TranslateGemma", "active", "Tlumaczenie"),
      step("XTTS", "idle", "Czeka"),
      step("Markdown", "idle", "Czeka")
    ]);
    this.broadcast({ type: "segment", segment, session: this.session });

    const started = performance.now();
    const translated = await this.translatePageText(segment.originalText, segment.detectedLanguage, target);
    segment.timings.translate = Math.round(performance.now() - started);
    segment.translatedText = translated;
    segment.translations[target] = translated;
  }

  private async synthesizeTranslation(segment: Segment) {
    if (!segment.translatedText || !segment.targetLanguage) {
      throw new Error("Brak tlumaczenia do syntezy glosu.");
    }

    const targetLanguage = getLanguage(segment.targetLanguage);
    if (!targetLanguage?.ttsCode) {
      segment.audioError = `XTTS nie obsluguje lokalnego odtwarzania audio dla jezyka: ${
        targetLanguage?.label ?? segment.targetLanguage
      }. Tekst tlumaczenia jest zapisany.`;
      this.setSteps([
        step("Whisper", "ok", "Gotowe", segment.timings.transcribe),
        step("TranslateGemma", "ok", "Gotowe", segment.timings.translate),
        step("XTTS", "ok", "Pominieto glos"),
        step("Markdown", "idle", "Czeka")
      ]);
      await this.persistSegments();
      this.broadcast({ type: "segment", segment, session: this.session });
      return;
    }

    segment.status = "synthesizing";
    this.setSteps([
      step("Whisper", "ok", "Gotowe", segment.timings.transcribe),
      step("TranslateGemma", "ok", "Gotowe", segment.timings.translate),
      step("XTTS", "active", "Synteza glosu"),
      step("Markdown", "idle", "Czeka")
    ]);
    this.broadcast({ type: "segment", segment, session: this.session });

    try {
      await this.ensureTranslationAudio(segment);
      this.setSteps([
        step("Whisper", "ok", "Gotowe", segment.timings.transcribe),
        step("TranslateGemma", "ok", "Gotowe", segment.timings.translate),
        step("XTTS", "ok", "Audio gotowe", segment.timings.tts),
        step("Markdown", "idle", "Czeka")
      ]);
    } catch (error) {
      segment.audioError = error instanceof Error ? error.message : String(error);
      this.setSteps([
        step("Whisper", "ok", "Gotowe", segment.timings.transcribe),
        step("TranslateGemma", "ok", "Gotowe", segment.timings.translate),
        step("XTTS", "error", "Blad TTS"),
        step("Markdown", "idle", "Czeka")
      ]);
      await this.persistSegments();
      this.broadcast({ type: "segment", segment, session: this.session });
    }
  }

  private async writeSessionFiles(segment?: Segment) {
    const ttsStep = stepForTtsResult(segment);
    this.setSteps([
      step("Whisper", "ok", "Gotowe"),
      step("TranslateGemma", "ok", "Gotowe"),
      ttsStep,
      step("Markdown", "active", "Zapis plikow")
    ]);

    await mkdir(this.session.dir, { recursive: true });
    await this.atomicWrite(
      path.join(this.session.dir, "original.md"),
      renderOriginalMarkdown(this.session.id, this.session.createdAt, this.session.segments, languageLabels)
    );
    const translationPageLanguages = this.translationPageLanguages();
    await this.backfillTranslationPages(translationPageLanguages);
    for (const language of translationPageLanguages) {
      await this.atomicWrite(
        path.join(this.session.dir, `translated.${language}.md`),
        renderTranslatedMarkdown(this.session.id, this.session.createdAt, language, this.session.segments, languageLabels)
      );
    }
    await this.persistSegments();
    this.session.files = await this.listFiles();
    this.setSteps([
      step("Whisper", "ok", "Gotowe"),
      step("TranslateGemma", "ok", "Gotowe"),
      ttsStep,
      step("Markdown", "ok", "Zapisano")
    ]);
    this.broadcast({ type: "session", session: this.session });
  }

  private async ensureTranslationAudio(segment: Segment) {
    if (!segment.translatedText || !segment.targetLanguage) {
      throw new Error("Tlumaczenie nie jest jeszcze gotowe.");
    }
    const targetLanguage = getLanguage(segment.targetLanguage);
    if (!targetLanguage?.ttsCode) {
      throw new Error(`XTTS nie obsluguje lokalnego odtwarzania audio dla jezyka: ${targetLanguage?.label ?? segment.targetLanguage}. Tekst tlumaczenia jest zapisany.`);
    }
    if (!segment.wavPath || !(await Bun.file(segment.wavPath).exists())) {
      throw new Error("Brak oryginalnego WAV do referencji glosu XTTS.");
    }
    if (segment.translationAudioPath && (await Bun.file(segment.translationAudioPath).exists())) {
      return segment.translationAudioPath;
    }

    const ttsDir = path.join(this.session.dir, "tts");
    await mkdir(ttsDir, { recursive: true });
    const outputPath = path.join(ttsDir, `${segment.id}.${segment.targetLanguage}.wav`);

    segment.audioError = undefined;
    segment.translationAudioPath = outputPath;
    this.broadcast({ type: "segment", segment, session: this.session });

    const result = await synthesizeSpeech({
      text: segment.translatedText,
      language: targetLanguage.ttsCode,
      speakerWav: segment.wavPath,
      outputPath
    });

    segment.timings.tts = result.durationMs;
    if (!result.ok) {
      segment.audioError = result.stderr.trim() || "XTTS nie wygenerowal audio.";
      segment.translationAudioPath = undefined;
      await this.persistSegments();
      this.broadcast({ type: "segment", segment, session: this.session });
      throw new Error(segment.audioError);
    }

    await this.persistSegments();
    this.broadcast({ type: "segment", segment, session: this.session });
    return outputPath;
  }

  private async retryTranslationAudioInBackground(segment: Segment) {
    try {
      await this.ensureTranslationAudio(segment);
    } catch (error) {
      segment.audioError = error instanceof Error ? error.message : String(error);
    } finally {
      segment.status = "done";
      await this.persistSegments();
      this.setSteps([
        step("Whisper", "ok", "Gotowe", segment.timings.transcribe),
        step("TranslateGemma", "ok", "Gotowe", segment.timings.translate),
        stepForTtsResult(segment),
        step("Markdown", "ok", "Zapisano")
      ]);
      this.broadcast({ type: "segment", segment, session: this.session });
    }
  }

  private async persistSegments() {
    await this.atomicWrite(path.join(this.session.dir, "segments.json"), JSON.stringify(this.session, null, 2));
    this.session.files = await this.listFiles().catch(() => this.session.files);
  }

  private translationPageLanguages() {
    const codes = new Set<LanguageCode>();
    const add = (code: string | undefined) => {
      if (code && getLanguage(code)) {
        codes.add(code as LanguageCode);
      }
    };

    add(this.session.languageA);
    add(this.session.languageB);
    for (const segment of this.session.segments) {
      add(segment.languageA);
      add(segment.languageB);
      add(segment.detectedLanguage);
      add(segment.targetLanguage);
      for (const code of Object.keys(segment.translations)) {
        add(code);
      }
    }

    return [...codes];
  }

  private async backfillTranslationPages(targetLanguages: LanguageCode[]) {
    const pageSegments = this.session.segments.filter((item) => item.status === "done" || item.status === "writing");
    for (const segment of pageSegments) {
      if (!segment.originalText || !segment.detectedLanguage) {
        continue;
      }

      if (!lineHasText(segment.translations[segment.detectedLanguage])) {
        segment.translations[segment.detectedLanguage] = segment.originalText;
      }

      for (const targetLanguage of targetLanguages) {
        if (lineHasText(segment.translations[targetLanguage])) {
          continue;
        }
        if (targetLanguage === segment.detectedLanguage) {
          segment.translations[targetLanguage] = segment.originalText;
          continue;
        }
        segment.translations[targetLanguage] = await this.translatePageText(
          segment.originalText,
          segment.detectedLanguage,
          targetLanguage
        );
      }
    }
  }

  private async atomicWrite(filePath: string, content: string) {
    const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  }

  private setSteps(steps: ProcessingStep[]) {
    this.session.steps = steps;
    this.broadcast({ type: "steps", steps });
  }
}

function isAllowedAudio(mimeType: string) {
  return (
    /audio\/(webm|ogg|mp4|mpeg|wav|x-wav)/i.test(mimeType) ||
    mimeType === "video/webm" ||
    mimeType === "application/octet-stream"
  );
}

function lineHasText(text: string | undefined) {
  return Boolean(text?.trim());
}

function isSessionFileName(name: string) {
  return coreSessionFileNames.includes(name) || /^translated\.[a-z]{2}\.md$/.test(name);
}

function existingSessionDirectoryNames() {
  try {
    return readdirSync(appConfig.sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function extensionForMime(mimeType: string) {
  if (/ogg/i.test(mimeType)) return "ogg";
  if (/mp4/i.test(mimeType)) return "m4a";
  if (/wav/i.test(mimeType)) return "wav";
  return "webm";
}

function stepForTtsResult(segment?: Segment) {
  if (!segment?.translatedText || !segment.targetLanguage) {
    return step("XTTS", "ok", "Gotowe");
  }
  const targetLanguage = getLanguage(segment.targetLanguage);
  if (!targetLanguage?.ttsCode) {
    return step("XTTS", "ok", "Pominieto glos");
  }
  if (segment.audioError) {
    return step("XTTS", "error", "Blad TTS");
  }
  if (segment.timings.tts) {
    return step("XTTS", "ok", "Audio gotowe", segment.timings.tts);
  }
  return step("XTTS", "idle", "Czeka");
}

function defaultSteps(status: ProcessingStep["status"] = "idle"): ProcessingStep[] {
  return [
    step("Whisper", status === "error" ? "error" : "idle", status === "error" ? "Blad" : "Czeka"),
    step("TranslateGemma", status === "error" ? "error" : "idle", status === "error" ? "Blad" : "Czeka"),
    step("XTTS", status === "error" ? "error" : "idle", status === "error" ? "Blad" : "Czeka"),
    step("Markdown", status === "error" ? "error" : "idle", status === "error" ? "Blad" : "Czeka")
  ];
}

function step(
  name: ProcessingStep["name"],
  status: ProcessingStep["status"],
  detail: string,
  latencyMs?: number
): ProcessingStep {
  return { name, status, detail, latencyMs };
}
