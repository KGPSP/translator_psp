export type CommandResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export async function runCommand(
  command: string[],
  timeoutMs = 120_000,
  env?: Record<string, string>
): Promise<CommandResult> {
  const started = performance.now();
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Process may have exited between timeout scheduling and kill.
    }
  }, timeoutMs);

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timeout);

  return {
    ok: code === 0 && !timedOut,
    code,
    stdout,
    stderr: timedOut && !stderr.trim() ? `Proces przekroczyl limit ${Math.round(timeoutMs / 1000)}s.` : stderr,
    durationMs: Math.round(performance.now() - started),
    timedOut
  };
}
