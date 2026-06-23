import path from "node:path";
import { appConfig, getLanguage, languages, type LanguageCode } from "./config";
import { checkHealth } from "./health";
import { SessionStore } from "./session-store";
import type { ClientEvent } from "./types";

const sockets = new Set<Bun.ServerWebSocket<unknown>>();

function broadcast(event: ClientEvent | unknown) {
  const message = JSON.stringify(event);
  for (const socket of sockets) {
    socket.send(message);
  }
}

const store = new SessionStore(broadcast);
await store.initialize();

const server = Bun.serve({
  hostname: appConfig.host,
  port: appConfig.port,
  idleTimeout: appConfig.idleTimeoutSeconds,
  async fetch(req, serverInstance) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const upgraded = serverInstance.upgrade(req);
      if (upgraded) return undefined;
      return json({ error: "WebSocket upgrade failed" }, 400);
    }

    try {
      if (url.pathname === "/api/health" && req.method === "GET") {
        return json({ health: await checkHealth() });
      }

      if (url.pathname === "/api/config" && req.method === "GET") {
        return json({
          languages,
          segmentSeconds: appConfig.segmentSeconds,
          maxAudioBytes: appConfig.maxAudioBytes
        });
      }

      if (url.pathname === "/api/session" && req.method === "GET") {
        return json({ session: store.getSession() });
      }

      if (url.pathname === "/api/session/reset" && req.method === "POST") {
        const body = (await req.json()) as { languageA?: LanguageCode; languageB?: LanguageCode };
        const languageA = body.languageA ?? "pl";
        const languageB = body.languageB ?? "en";
        if (!getLanguage(languageA) || !getLanguage(languageB) || languageA === languageB) {
          return json({ error: "Nieprawidlowa para jezykow." }, 400);
        }
        return json({ session: await store.reset(languageA, languageB) });
      }

      if (url.pathname === "/api/segments" && req.method === "POST") {
        const form = await req.formData();
        const file = form.get("audio");
        if (!(file instanceof File)) {
          return json({ error: "Brak pola audio." }, 400);
        }
        const languageA = String(form.get("languageA") ?? "pl") as LanguageCode;
        const languageB = String(form.get("languageB") ?? "en") as LanguageCode;
        const segment = await store.acceptAudio({
          file,
          languageA,
          languageB,
          mimeType: file.type
        });
        return json({ segment }, 202);
      }

      const retryMatch = url.pathname.match(/^\/api\/segments\/([^/]+)\/retry$/);
      if (retryMatch && req.method === "POST") {
        return json({ segment: await store.retrySegment(retryMatch[1]) });
      }

      const audioRetryMatch = url.pathname.match(/^\/api\/segments\/([^/]+)\/audio\/translation\/retry$/);
      if (audioRetryMatch && req.method === "POST") {
        return json({ segment: await store.retryTranslationAudio(audioRetryMatch[1]) }, 202);
      }

      const audioMatch = url.pathname.match(/^\/api\/segments\/([^/]+)\/audio\/(original|translation)$/);
      if (audioMatch && req.method === "GET") {
        return await serveSegmentAudio(audioMatch[1], audioMatch[2] as "original" | "translation");
      }

      const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
      if (fileMatch && req.method === "GET") {
        return await serveSessionFile(fileMatch[1]);
      }

      return await serveStatic(url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      broadcast({ type: "error", message });
      return json({ error: message }, 500);
    }
  },
  websocket: {
    open(socket) {
      sockets.add(socket);
      socket.send(JSON.stringify({ type: "session", session: store.getSession() }));
    },
    close(socket) {
      sockets.delete(socket);
    },
    message() {
      // Server pushes state; client messages are not needed for this prototype.
    }
  }
});

console.log(`Tlumacz lokalny API: http://${server.hostname}:${server.port}`);

function json(payload: unknown, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

async function serveSessionFile(name: string) {
  const allowed = new Set(store.getSession().files.map((file) => file.name));
  if (!allowed.has(name)) {
    return json({ error: "Nieznany plik sesji." }, 404);
  }
  const file = store.getSession().files.find((item) => item.name === name);
  if (!file) {
    return json({ error: "Plik nie istnieje." }, 404);
  }
  return new Response(Bun.file(file.path), {
    headers: {
      "Content-Type": name.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      "Content-Disposition": `inline; filename="${name}"`
    }
  });
}

async function serveSegmentAudio(id: string, kind: "original" | "translation") {
  const filePath = await store.getSegmentAudioPath(id, kind);
  return new Response(Bun.file(filePath), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "audio/wav",
      "Content-Disposition": `inline; filename="${id}-${kind}.wav"`
    }
  });
}

async function serveStatic(pathname: string) {
  const distExists = await Bun.file(path.join(appConfig.distDir, "index.html")).exists();
  if (!distExists) {
    if (pathname === "/") {
      return new Response("Frontend dev server: http://127.0.0.1:5173", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
    return json({ error: "Not found" }, 404);
  }

  const safePath = safeJoin(appConfig.distDir, pathname === "/" ? "index.html" : pathname);
  if (!safePath) {
    return json({ error: "Not found" }, 404);
  }

  const file = Bun.file(safePath);
  if (await file.exists()) {
    return new Response(file);
  }

  return new Response(Bun.file(path.join(appConfig.distDir, "index.html")), {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function safeJoin(root: string, pathname: string) {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
  const resolved = path.resolve(root, decoded);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? resolved : null;
}
