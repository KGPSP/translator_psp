import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

const children: Bun.Subprocess[] = [];

function spawn(name: string, command: string[], env: Record<string, string> = {}, critical = true) {
  const proc = Bun.spawn(command, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    env: {
      ...process.env,
      ...env,
      FORCE_COLOR: "1"
    }
  });

  children.push(proc);
  proc.exited.then((code) => {
    if (code !== 0) {
      console.error(`${name} zakonczyl prace z kodem ${code}`);
      if (critical) {
        shutdown(code);
      }
    }
  });
}

function shutdown(code = 0) {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Process may already be gone.
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const apiPort = await findAvailablePort(Number(process.env.PORT ?? 3000));
const clientPort = Number(process.env.CLIENT_PORT ?? 5173);
const xttsWorkerEnabled = !["0", "false", "no"].includes((process.env.XTTS_WORKER_ENABLED ?? "1").toLowerCase());
const xttsWorkerPort = await resolveWorkerPort();
const xttsWorkerUrl = process.env.XTTS_WORKER_URL ?? `http://127.0.0.1:${xttsWorkerPort}`;
const xttsPython = process.env.XTTS_PYTHON ?? path.join(homedir(), "audio-ai/xtts/.venv/bin/python");

if (xttsWorkerEnabled) {
  if (await Bun.file(xttsPython).exists()) {
    spawn(
      "xtts-worker",
      [xttsPython, "scripts/xtts_worker.py"],
      {
        XTTS_WORKER_HOST: "127.0.0.1",
        XTTS_WORKER_PORT: String(xttsWorkerPort),
        XTTS_MODEL: process.env.XTTS_MODEL ?? "tts_models/multilingual/multi-dataset/xtts_v2",
        XTTS_DEVICE: process.env.XTTS_DEVICE ?? "auto",
        PYTORCH_ENABLE_MPS_FALLBACK: process.env.PYTORCH_ENABLE_MPS_FALLBACK ?? "1"
      },
      false
    );
  } else {
    console.error(`XTTS worker pominiety: nie znaleziono Pythona ${xttsPython}`);
  }
}

spawn("server", ["bun", "run", "server/index.ts"], {
  PORT: String(apiPort),
  XTTS_WORKER_ENABLED: xttsWorkerEnabled ? "1" : "0",
  XTTS_WORKER_URL: xttsWorkerUrl,
  XTTS_PYTHON: xttsPython
});
spawn("client", ["bun", "x", "vite", "--host", "127.0.0.1", "--port", String(clientPort)], {
  API_PORT: String(apiPort),
  VITE_API_PORT: String(apiPort)
});

console.log(`Backend:  http://127.0.0.1:${apiPort}`);
console.log(`Frontend: http://127.0.0.1:${clientPort}`);
console.log(`XTTS:     ${xttsWorkerEnabled ? xttsWorkerUrl : "worker wylaczony; fallback CLI"}`);

async function findAvailablePort(startPort: number) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Nie znaleziono wolnego portu od ${startPort} do ${startPort + 49}.`);
}

function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function resolveWorkerPort() {
  if (process.env.XTTS_WORKER_URL) {
    const parsed = new URL(process.env.XTTS_WORKER_URL);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number(process.env.XTTS_WORKER_PORT ?? port);
  }
  return await findAvailablePort(Number(process.env.XTTS_WORKER_PORT ?? 8765));
}
