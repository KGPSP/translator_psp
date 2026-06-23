import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "./config";
import { runCommand } from "./process";
import { checkTtsWorkerHealth } from "./tts-client";
import type { HealthItem } from "./types";

export async function checkHealth(): Promise<HealthItem[]> {
  const [ffmpeg, whisper, xtts, xttsWorker, ollama, sessions] = await Promise.all([
    checkFfmpeg(),
    checkWhisper(),
    checkXtts(),
    checkTtsWorkerHealth(),
    checkOllama(),
    checkSessions()
  ]);

  return [
    {
      name: "Bun",
      ok: true,
      detail: `v${Bun.version}`
    },
    ffmpeg,
    whisper,
    xtts,
    xttsWorker,
    ollama,
    sessions
  ];
}

async function checkFfmpeg(): Promise<HealthItem> {
  const result = await runCommand([appConfig.ffmpegPath, "-version"], 5_000);
  return {
    name: "FFmpeg",
    ok: result.ok,
    detail: result.ok ? result.stdout.split("\n")[0] ?? "Dostepny" : result.stderr || "Brak FFmpeg",
    latencyMs: result.durationMs
  };
}

async function checkWhisper(): Promise<HealthItem> {
  const exists = await Bun.file(appConfig.whisperPath).exists();
  return {
    name: "mlx-whisper",
    ok: exists,
    detail: exists ? appConfig.whisperPath : "Nie znaleziono binarki mlx_whisper"
  };
}

async function checkXtts(): Promise<HealthItem> {
  const exists = await Bun.file(appConfig.xttsPath).exists();
  return {
    name: "XTTS-v2",
    ok: exists,
    detail: exists ? appConfig.xttsPath : "Nie znaleziono binarki tts"
  };
}

async function checkOllama(): Promise<HealthItem> {
  const started = performance.now();
  try {
    const response = await fetch(`${appConfig.ollamaUrl}/api/tags`);
    if (!response.ok) {
      return {
        name: "Ollama / TranslateGemma",
        ok: false,
        detail: `HTTP ${response.status}`,
        latencyMs: Math.round(performance.now() - started)
      };
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const model = payload.models?.find(
      (item) => item.name === appConfig.ollamaModel || item.model === appConfig.ollamaModel
    );
    return {
      name: "Ollama / TranslateGemma",
      ok: Boolean(model),
      detail: model ? appConfig.ollamaModel : "Model nie jest widoczny w ollama list",
      latencyMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      name: "Ollama / TranslateGemma",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - started)
    };
  }
}

async function checkSessions(): Promise<HealthItem> {
  try {
    await mkdir(appConfig.sessionsDir, { recursive: true });
    const probePath = path.join(appConfig.sessionsDir, ".healthcheck");
    await writeFile(probePath, "ok", "utf8");
    return {
      name: "Folder sesji",
      ok: true,
      detail: appConfig.sessionsDir
    };
  } catch (error) {
    return {
      name: "Folder sesji",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}
