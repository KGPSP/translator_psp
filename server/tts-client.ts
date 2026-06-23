import { appConfig } from "./config";
import { runCommand, type CommandResult } from "./process";
import type { HealthItem } from "./types";

export type TtsSynthesizeInput = {
  text: string;
  language: string;
  speakerWav: string;
  outputPath: string;
};

export type TtsResult = CommandResult & {
  provider: "worker" | "cli";
  fallbackReason?: string;
};

type WorkerHealthPayload = {
  ok?: boolean;
  ready?: boolean;
  model?: string;
  device?: string;
  load_ms?: number;
  error?: string;
};

type WorkerSynthesizePayload = {
  ok?: boolean;
  output_path?: string;
  duration_ms?: number;
  error?: string;
};

export async function synthesizeSpeech(input: TtsSynthesizeInput): Promise<TtsResult> {
  const started = performance.now();
  let fallbackReason: string | undefined;

  if (appConfig.xttsWorkerEnabled) {
    const workerResult = await synthesizeWithWorker(input);
    if (workerResult.ok) {
      return workerResult;
    }
    fallbackReason = workerResult.stderr.trim() || "Worker XTTS nie wygenerowal audio.";
  }

  const cliResult = await synthesizeWithCli(input);
  const durationMs = Math.round(performance.now() - started);
  if (!fallbackReason) {
    return { ...cliResult, provider: "cli", durationMs };
  }

  return {
    ...cliResult,
    provider: "cli",
    durationMs,
    fallbackReason,
    stderr: cliResult.ok
      ? cliResult.stderr
      : [`XTTS worker: ${fallbackReason}`, `XTTS CLI: ${cliResult.stderr.trim() || "Brak szczegolow bledu."}`].join(
          "\n"
        )
  };
}

export async function checkTtsWorkerHealth(): Promise<HealthItem> {
  if (!appConfig.xttsWorkerEnabled) {
    return {
      name: "XTTS worker",
      ok: true,
      detail: "Wylaczony; aktywny fallback CLI"
    };
  }

  const started = performance.now();
  try {
    const response = await fetchWithTimeout(workerEndpoint("/health"), {
      method: "GET",
      timeoutMs: 2_000
    });
    const payload = (await response.json().catch(() => ({}))) as WorkerHealthPayload;
    const latencyMs = Math.round(performance.now() - started);

    if (!response.ok || payload.ok === false || payload.ready === false) {
      return {
        name: "XTTS worker",
        ok: false,
        detail: payload.error ?? `HTTP ${response.status}; fallback CLI aktywny`,
        latencyMs
      };
    }

    const load = typeof payload.load_ms === "number" ? `, start ${Math.round(payload.load_ms)}ms` : "";
    return {
      name: "XTTS worker",
      ok: true,
      detail: `${payload.device ?? "device?"} / ${payload.model ?? appConfig.xttsModel}${load}`,
      latencyMs
    };
  } catch (error) {
    return {
      name: "XTTS worker",
      ok: false,
      detail: `${errorMessage(error)}; fallback CLI aktywny`,
      latencyMs: Math.round(performance.now() - started)
    };
  }
}

async function synthesizeWithWorker(input: TtsSynthesizeInput): Promise<TtsResult> {
  const started = performance.now();
  try {
    const response = await fetchWithTimeout(workerEndpoint("/synthesize"), {
      method: "POST",
      timeoutMs: appConfig.xttsWorkerTimeoutMs,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: input.text,
        language: input.language,
        speaker_wav: input.speakerWav,
        output_path: input.outputPath,
        split_sentences: true
      })
    });
    const payload = (await response.json().catch(() => ({}))) as WorkerSynthesizePayload;
    const durationMs = Math.round(performance.now() - started);

    if (!response.ok || payload.ok === false) {
      return commandLikeResult({
        ok: false,
        stderr: payload.error ?? `Worker XTTS zwrocil HTTP ${response.status}.`,
        durationMs,
        provider: "worker"
      });
    }

    if (!(await Bun.file(input.outputPath).exists())) {
      return commandLikeResult({
        ok: false,
        stderr: "Worker XTTS zakonczyl prace, ale nie utworzyl pliku audio.",
        durationMs,
        provider: "worker"
      });
    }

    return commandLikeResult({
      ok: true,
      stdout: payload.output_path ?? input.outputPath,
      durationMs,
      provider: "worker"
    });
  } catch (error) {
    return commandLikeResult({
      ok: false,
      stderr: errorMessage(error),
      durationMs: Math.round(performance.now() - started),
      timedOut: error instanceof DOMException && error.name === "AbortError",
      provider: "worker"
    });
  }
}

async function synthesizeWithCli(input: TtsSynthesizeInput): Promise<TtsResult> {
  const result = await runCommand(
    [
      appConfig.xttsPath,
      "--model_name",
      appConfig.xttsModel,
      "--text",
      input.text,
      "--language_idx",
      input.language,
      "--speaker_wav",
      input.speakerWav,
      "--out_path",
      input.outputPath
    ],
    appConfig.xttsTimeoutMs,
    { COQUI_TOS_AGREED: "1" }
  );

  return { ...result, provider: "cli" };
}

function commandLikeResult(
  result: Partial<CommandResult> & Pick<TtsResult, "ok" | "durationMs" | "provider">
): TtsResult {
  return {
    ok: result.ok,
    code: result.ok ? 0 : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: result.durationMs,
    timedOut: result.timedOut ?? false,
    provider: result.provider
  };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs: number }
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function workerEndpoint(pathname: string) {
  const base = appConfig.xttsWorkerUrl.endsWith("/") ? appConfig.xttsWorkerUrl : `${appConfig.xttsWorkerUrl}/`;
  return new URL(pathname.replace(/^\/+/, ""), base).toString();
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
