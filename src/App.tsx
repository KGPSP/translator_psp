import {
  AlertCircle,
  Check,
  ChevronDown,
  Circle,
  FileText,
  FolderOpen,
  Mic,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  Volume2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientEvent, HealthItem, LanguageCode, LanguageOption, Segment, SessionFile, SessionState } from "./types";

type AppConfig = {
  languages: LanguageOption[];
  segmentSeconds: number;
  maxAudioBytes: number;
};

type UserStatus = {
  label: string;
  detail: string;
  tone: "idle" | "active" | "ok" | "error";
};

type TimingKey = keyof Segment["timings"];

type WaitTarget = {
  key: string;
  label: string;
  segmentId?: string;
  timingKeys: TimingKey[];
};

type WaitState = {
  key: string;
  startedAtMs: number;
};

type ProcessingTimer = {
  key: string;
  label: string;
  segmentId?: string;
  elapsedMs: number;
  estimatedMs?: number;
  remainingMs?: number;
  progress?: number;
};

const apiBase = "";
const devApiPort = import.meta.env.VITE_API_PORT ?? "3000";
const wsHost = location.port === "5173" ? `${location.hostname}:${devApiPort}` : location.host;
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${wsHost}/ws`;

const fallbackConfig: AppConfig = {
  segmentSeconds: 600,
  maxAudioBytes: 200 * 1024 * 1024,
  languages: [
    { code: "pl", label: "Polski", englishName: "Polish", whisperAliases: ["pl"], ttsCode: "pl" },
    { code: "en", label: "English", englishName: "English", whisperAliases: ["en"], ttsCode: "en" }
  ]
};

export function App() {
  const [config, setConfig] = useState<AppConfig>(fallbackConfig);
  const [session, setSession] = useState<SessionState | null>(null);
  const [health, setHealth] = useState<HealthItem[]>([]);
  const [languageA, setLanguageA] = useState<LanguageCode>("pl");
  const [languageB, setLanguageB] = useState<LanguageCode>("en");
  const [isRecording, setIsRecording] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [loadingAudioKeys, setLoadingAudioKeys] = useState<Set<string>>(new Set());
  const [activePlaybackKey, setActivePlaybackKey] = useState<string | null>(null);
  const [folderCopied, setFolderCopied] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [waitState, setWaitState] = useState<WaitState | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const activePlaybackSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const segmentTimerRef = useRef<number | null>(null);
  const shouldRecordRef = useRef(false);
  const isStartingRecordingRef = useRef(false);
  const recorderMimeTypeRef = useRef("");
  const discardStoppedSegmentRef = useRef(false);
  const recordingUploadSentRef = useRef(false);
  const playbackActiveRef = useRef(false);
  const activePlaybackKeyRef = useRef<string | null>(null);
  const autoPlaybackUnlockedRef = useRef(false);
  const autoPlayedSegmentIdsRef = useRef<Set<string>>(new Set());
  const autoQueuedSegmentIdsRef = useRef<Set<string>>(new Set());
  const playbackQueueRef = useRef<Promise<void>>(Promise.resolve());
  const folderCopiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void bootstrap();

    let socket: WebSocket | null = null;
    const socketTimer = window.setTimeout(() => {
      socket = new WebSocket(wsUrl);
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(event.data) as ClientEvent;
        if (payload.type === "session") {
          applySession(payload.session);
        }
        if (payload.type === "segment") {
          applySession(payload.session);
        }
        if (payload.type === "steps") {
          setSession((current) => (current ? { ...current, steps: payload.steps } : current));
        }
        if (payload.type === "health") {
          setHealth(payload.health);
        }
        if (payload.type === "error") {
          setError(payload.message);
        }
      });
    }, 0);

    return () => {
      window.clearTimeout(socketTimer);
      socket?.close();
      cleanupRecording();
      cleanupAudioPlayer();
      if (folderCopiedTimerRef.current) {
        window.clearTimeout(folderCopiedTimerRef.current);
      }
    };
  }, []);

  const languageMap = useMemo(
    () => Object.fromEntries(config.languages.map((language) => [language.code, language])),
    [config.languages]
  ) as Record<LanguageCode, LanguageOption>;

  const rows = session?.segments ?? [];
  const steps = session?.steps ?? [];
  const sessionFiles = session?.files ?? [];
  const languageALabel = languageMap[languageA]?.label ?? languageA.toUpperCase();
  const languageBLabel = languageMap[languageB]?.label ?? languageB.toUpperCase();
  const currentStatus = getUserStatus(rows, isRecording, isStartingRecording, error);
  const waitTarget = getWaitTarget(rows, isStartingRecording, isRecording);
  const processingTimer =
    waitTarget && waitState?.key === waitTarget.key ? getProcessingTimer(waitTarget, waitState.startedAtMs, nowMs, rows) : null;
  const originalFile = sessionFiles.find((file) => file.name === "original.md");
  const translatedFiles = [languageA, languageB].map((language) => ({
    language,
    file: sessionFiles.find((file) => file.name === `translated.${language}.md`)
  }));
  const healthIssues = health.filter((item) => !item.ok);
  const healthSummary =
    health.length === 0 ? "Sprawdzanie..." : healthIssues.length === 0 ? "Wszystko gotowe" : `${healthIssues.length} wymaga uwagi`;

  useEffect(() => {
    setWaitState((current) => {
      if (!waitTarget) {
        return null;
      }
      if (current?.key === waitTarget.key) {
        return current;
      }
      return { key: waitTarget.key, startedAtMs: Date.now() };
    });
    setNowMs(Date.now());
  }, [waitTarget?.key]);

  useEffect(() => {
    if (!waitTarget) {
      return;
    }
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [waitTarget?.key]);

  function applySession(nextSession: SessionState) {
    setSession(nextSession);
    setLanguageA(nextSession.languageA);
    setLanguageB(nextSession.languageB);

    if (!autoPlaybackUnlockedRef.current) {
      return;
    }

    for (const segment of nextSession.segments) {
      if (
        segment.status === "done" &&
        segment.translatedText &&
        segment.targetLanguage &&
        languageMap[segment.targetLanguage]?.ttsCode &&
        segment.translationAudioPath &&
        !segment.audioError &&
        !autoPlayedSegmentIdsRef.current.has(segment.id) &&
        !autoQueuedSegmentIdsRef.current.has(segment.id)
      ) {
        autoQueuedSegmentIdsRef.current.add(segment.id);
        enqueuePlayback(segment.id, "translation", true);
      }
    }
  }

  async function bootstrap() {
    const [configResponse, sessionResponse, healthResponse] = await Promise.all([
      fetch(`${apiBase}/api/config`),
      fetch(`${apiBase}/api/session`),
      fetch(`${apiBase}/api/health`)
    ]);
    const configPayload = (await configResponse.json()) as AppConfig;
    const sessionPayload = (await sessionResponse.json()) as { session: SessionState };
    const healthPayload = (await healthResponse.json()) as { health: HealthItem[] };
    setConfig(configPayload);
    applySession(sessionPayload.session);
    setHealth(healthPayload.health);
  }

  async function refreshHealth() {
    const response = await fetch(`${apiBase}/api/health`);
    const payload = (await response.json()) as { health: HealthItem[] };
    setHealth(payload.health);
  }

  async function resetSession() {
    setIsResetting(true);
    setError(null);
    setFolderCopied(false);
    if (isRecording) {
      discardStoppedSegmentRef.current = true;
      cleanupRecording();
      setIsRecording(false);
    }
    try {
      const response = await fetch(`${apiBase}/api/session/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ languageA, languageB })
      });
      const payload = (await response.json()) as { session?: SessionState; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Nie udało się utworzyć sesji.");
      autoPlayedSegmentIdsRef.current.clear();
      autoQueuedSegmentIdsRef.current.clear();
      if (payload.session) {
        applySession(payload.session);
      } else {
        setSession(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsResetting(false);
    }
  }

  async function toggleRecording() {
    if (isRecording || shouldRecordRef.current) {
      cleanupRecording();
      setIsRecording(false);
      return;
    }
    if (isStartingRecordingRef.current) {
      return;
    }

    setError(null);
    let audioUnlock: Promise<void> | undefined;
    isStartingRecordingRef.current = true;
    setIsStartingRecording(true);
    try {
      audioUnlock = unlockAutoPlayback();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      streamRef.current = stream;
      setupMeter(stream);

      const mimeType = pickMimeType();
      recorderMimeTypeRef.current = mimeType;
      await audioUnlock;
      shouldRecordRef.current = true;
      recordingUploadSentRef.current = false;
      startRecorderSegment(stream, mimeType);
      setRecordingSeconds(0);
      timerRef.current = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
      setIsRecording(true);
    } catch (cause) {
      await audioUnlock?.catch(() => undefined);
      cleanupRecording();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      isStartingRecordingRef.current = false;
      setIsStartingRecording(false);
    }
  }

  async function unlockAutoPlayback() {
    const context = playbackContextRef.current ?? new AudioContext();
    playbackContextRef.current = context;
    if (context.state !== "running") {
      await context.resume();
    }
    playSilentUnlockBuffer(context);
    if (context.state !== "running") {
      throw new Error("Przeglądarka zablokowała dźwięk. Kliknij odtwarzanie ponownie albo rozpocznij nagrywanie.");
    }
    autoPlaybackUnlockedRef.current = true;
  }

  function startRecorderSegment(stream: MediaStream, mimeType: string) {
    if (!shouldRecordRef.current || !stream.active) return;

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      if (recorderRef.current === recorder) {
        recorderRef.current = null;
      }
      if (segmentTimerRef.current) {
        window.clearTimeout(segmentTimerRef.current);
        segmentTimerRef.current = null;
      }
      const blobType = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunks, { type: blobType });
      const shouldUpload = !discardStoppedSegmentRef.current && !recordingUploadSentRef.current;
      discardStoppedSegmentRef.current = false;
      if (shouldUpload && blob.size > 1200) {
        recordingUploadSentRef.current = true;
        void uploadSegment(blob);
      }
    });

    recorder.start();
    segmentTimerRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") {
        cleanupRecording();
        setIsRecording(false);
      }
    }, config.segmentSeconds * 1000);
  }

  async function uploadSegment(blob: Blob) {
    if (blob.size < 1200) return;
    const form = new FormData();
    form.set("audio", blob, `segment-${Date.now()}.webm`);
    form.set("languageA", languageA);
    form.set("languageB", languageB);
    const response = await fetch(`${apiBase}/api/segments`, {
      method: "POST",
      body: form
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Nie udało się wysłać fragmentu.");
    }
  }

  async function retrySegment(segment: Segment) {
    const response = await fetch(`${apiBase}/api/segments/${segment.id}/retry`, { method: "POST" });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Nie udało się ponowić fragmentu.");
    }
  }

  function playSegmentAudio(segment: Segment, kind: "original" | "translation") {
    const key = `${segment.id}:${kind}`;
    if (activePlaybackKeyRef.current === key) {
      stopPlayback();
      return;
    }

    if (kind === "translation" && segment.audioError) {
      void retryTranslationAudio(segment);
      return;
    }

    const audioUnlock = unlockAutoPlayback();
    enqueuePlayback(segment.id, kind, false, audioUnlock);
  }

  async function retryTranslationAudio(segment: Segment) {
    const key = `${segment.id}:translation`;
    setError(null);
    setAudioLoading(key, true);
    const audioUnlock = unlockAutoPlayback();
    try {
      await withTimeout(
        audioUnlock,
        2500,
        "Przeglądarka nie odblokowała dźwięku. Kliknij odtwarzanie ponownie albo rozpocznij nagrywanie."
      );
      const response = await fetch(`${apiBase}/api/segments/${segment.id}/audio/translation/retry`, {
        method: "POST"
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Nie udało się ponowić audio.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAudioLoading(key, false);
    }
  }

  function stopPlayback() {
    cleanupAudioPlayer();
    playbackActiveRef.current = false;
    activePlaybackKeyRef.current = null;
    setActivePlaybackKey(null);
  }

  function enqueuePlayback(
    segmentId: string,
    kind: "original" | "translation",
    automatic: boolean,
    audioUnlock: Promise<void> = Promise.resolve()
  ) {
    void prepareAndQueuePlayback(segmentId, kind, automatic, audioUnlock);
  }

  async function prepareAndQueuePlayback(
    segmentId: string,
    kind: "original" | "translation",
    automatic: boolean,
    audioUnlock: Promise<void>
  ) {
    const key = `${segmentId}:${kind}`;
    setError(null);
    try {
      await withTimeout(
        audioUnlock,
        2500,
        "Przeglądarka nie odblokowała dźwięku. Kliknij odtwarzanie ponownie albo rozpocznij nagrywanie."
      );
      setAudioLoading(key, true);
      const context = await ensurePlaybackContext();
      const response = await fetch(`${apiBase}/api/segments/${segmentId}/audio/${kind}?t=${Date.now()}`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Nie udało się przygotować audio.");
      }
      const audioBuffer = await context.decodeAudioData(await response.arrayBuffer());
      setAudioLoading(key, false);
      const playback = playbackQueueRef.current
        .catch(() => undefined)
        .then(() => playPreparedAudio(context, audioBuffer, segmentId, kind, automatic));
      playbackQueueRef.current = playback;
      await playback;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setAudioLoading(key, false);
      if (automatic) {
        autoQueuedSegmentIdsRef.current.delete(segmentId);
      }
    }
  }

  async function playPreparedAudio(
    context: AudioContext,
    audioBuffer: AudioBuffer,
    segmentId: string,
    kind: "original" | "translation",
    automatic: boolean
  ) {
    const key = `${segmentId}:${kind}`;
    try {
      cleanupAudioPlayer();
      playbackActiveRef.current = true;
      activePlaybackKeyRef.current = key;
      setActivePlaybackKey(key);
      await playDecodedAudio(context, audioBuffer);
      if (automatic) {
        autoPlayedSegmentIdsRef.current.add(segmentId);
      }
    } catch (cause) {
      cleanupAudioPlayer();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (automatic) {
        autoQueuedSegmentIdsRef.current.delete(segmentId);
      }
      playbackActiveRef.current = false;
      if (activePlaybackKeyRef.current === key) {
        activePlaybackKeyRef.current = null;
        setActivePlaybackKey(null);
      }
    }
  }

  function setAudioLoading(key: string, loading: boolean) {
    setLoadingAudioKeys((current) => {
      const next = new Set(current);
      if (loading) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }

  async function ensurePlaybackContext() {
    const context = playbackContextRef.current ?? new AudioContext();
    playbackContextRef.current = context;
    if (context.state !== "running") {
      await context.resume();
    }
    if (context.state !== "running") {
      throw new Error("Audio jest nadal zablokowane przez przeglądarkę. Kliknij odtwarzanie ponownie.");
    }
    return context;
  }

  function playSilentUnlockBuffer(context: AudioContext) {
    const buffer = context.createBuffer(1, 1, context.sampleRate);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
  }

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      promise.then(
        (value) => {
          window.clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timeout);
          reject(error);
        }
      );
    });
  }

  function playDecodedAudio(context: AudioContext, audioBuffer: AudioBuffer) {
    return new Promise<void>((resolve, reject) => {
      const source = context.createBufferSource();
      activePlaybackSourceRef.current = source;
      source.buffer = audioBuffer;
      source.connect(context.destination);
      source.addEventListener(
        "ended",
        () => {
          if (activePlaybackSourceRef.current === source) {
            activePlaybackSourceRef.current = null;
          }
          resolve();
        },
        { once: true }
      );
      try {
        source.start();
      } catch (error) {
        reject(error);
      }
    });
  }

  function swapLanguages() {
    setLanguageA(languageB);
    setLanguageB(languageA);
  }

  async function copySessionFolder() {
    if (!session?.dir) return;
    if (!navigator.clipboard) {
      setError("Nie udało się skopiować folderu. Przeglądarka nie udostępnia schowka.");
      return;
    }
    try {
      await navigator.clipboard.writeText(session.dir);
      setFolderCopied(true);
      if (folderCopiedTimerRef.current) {
        window.clearTimeout(folderCopiedTimerRef.current);
      }
      folderCopiedTimerRef.current = window.setTimeout(() => setFolderCopied(false), 2200);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się skopiować folderu.");
    }
  }

  function setupMeter(stream: MediaStream) {
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = audioContext;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / data.length;
      setLevel(Math.min(1, average / 110));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  function cleanupRecording() {
    shouldRecordRef.current = false;
    if (segmentTimerRef.current) window.clearTimeout(segmentTimerRef.current);
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) window.clearInterval(timerRef.current);
    void audioContextRef.current?.close();
    recorderRef.current = null;
    streamRef.current = null;
    audioContextRef.current = null;
    analyserRef.current = null;
    rafRef.current = null;
    timerRef.current = null;
    segmentTimerRef.current = null;
    setLevel(0);
    setRecordingSeconds(0);
  }

  function cleanupAudioPlayer() {
    try {
      activePlaybackSourceRef.current?.stop();
    } catch {
      // The source may already have ended.
    }
    activePlaybackSourceRef.current = null;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Volume2 size={19} />
          </span>
          <div>
            <h1>Tłumacz lokalny</h1>
            <p>Prywatne tłumaczenie rozmowy na tym komputerze</p>
          </div>
        </div>
        <span className="local-badge">
          <Check size={16} />
          Lokalnie
        </span>
      </header>

      <main className="workspace">
        <aside className="primary-panel" aria-label="Sterowanie tłumaczeniem">
          <section className="language-panel" aria-labelledby="language-title">
            <div className="panel-title-row">
              <div>
                <span className="section-kicker">Języki</span>
                <h2 id="language-title">Kierunek tłumaczenia</h2>
              </div>
            </div>
            <div className="language-switcher" aria-label="Wybierz parę języków">
              <LanguageSelect
                label="Mówię w"
                value={languageA}
                onChange={setLanguageA}
                languages={config.languages}
                exclude={languageB}
              />
              <button className="swap-button" onClick={swapLanguages} type="button" aria-label="Zamień języki">
                <RotateCcw size={17} />
                Zamień
              </button>
              <LanguageSelect
                label="Tłumacz na"
                value={languageB}
                onChange={setLanguageB}
                languages={config.languages}
                exclude={languageA}
              />
            </div>
          </section>

          <section className="record-panel" aria-labelledby="record-title">
            <div className="panel-title-row">
              <div>
                <span className="section-kicker">Nagrywanie</span>
                <h2 id="record-title">Mikrofon systemowy</h2>
              </div>
              <span className={`record-state ${isRecording ? "active" : ""}`}>
                {isStartingRecording ? "Uruchamianie" : isRecording ? "Nagrywa" : "Gotowy"}
              </span>
            </div>

            <div className="record-control">
              <button
                className={`record-button ${isRecording ? "recording" : ""}`}
                onClick={toggleRecording}
                disabled={isStartingRecording}
                type="button"
                aria-label={isRecording ? "Zatrzymaj nagrywanie" : "Rozpocznij nagrywanie"}
              >
                {isRecording ? <Square size={30} fill="currentColor" /> : <Circle size={38} fill="currentColor" />}
              </button>
              <div className="record-copy">
                <strong>{formatDuration(recordingSeconds)}</strong>
                <span>{isStartingRecording ? "Przygotowuję mikrofon" : isRecording ? "Mów naturalnie" : "Naciśnij, aby zacząć"}</span>
              </div>
            </div>

            <LevelMeter level={level} />
            {error ? <ErrorPanel message={error} onRefresh={refreshHealth} onDismiss={() => setError(null)} /> : null}
            <button className="new-session-button" onClick={resetSession} disabled={isResetting} type="button">
              <Plus size={18} />
              Nowe tłumaczenie
            </button>
          </section>
        </aside>

        <section className="conversation-panel" aria-labelledby="conversation-title">
          <div className="conversation-head">
            <div>
              <span className="section-kicker">Rozmowa</span>
              <h2 id="conversation-title">{languageALabel} → {languageBLabel}</h2>
              <p>Każdy fragment pojawi się tu jako oryginał i tłumaczenie.</p>
            </div>
            <span className={`status-badge ${currentStatus.tone}`} aria-live="polite">
              {currentStatus.label}
            </span>
          </div>

          <div className="conversation-list">
            {rows.length === 0 ? (
              <EmptyConversation source={languageALabel} target={languageBLabel} />
            ) : (
              rows.map((segment) => (
                <SegmentRow
                  key={segment.id}
                  segment={segment}
                  languageMap={languageMap}
                  loadingAudioKeys={loadingAudioKeys}
                  activePlaybackKey={activePlaybackKey}
                  onRetry={() => retrySegment(segment)}
                  onRetryAudio={() => retryTranslationAudio(segment)}
                  onPlayOriginal={() => playSegmentAudio(segment, "original")}
                  onPlayTranslation={() => playSegmentAudio(segment, "translation")}
                  timer={processingTimer?.segmentId === segment.id ? processingTimer : null}
                />
              ))
            )}
          </div>
        </section>

        <aside className="support-panel" aria-label="Status i wyniki">
          <section className="progress-panel" aria-labelledby="progress-title">
            <div className="panel-title-row">
              <div>
                <span className="section-kicker">Status</span>
                <h2 id="progress-title">{currentStatus.label}</h2>
              </div>
              <StatusDot status={statusToneToStepStatus(currentStatus.tone)} />
            </div>
            <p className="status-detail">{currentStatus.detail}</p>
            {processingTimer ? <WaitTimer timer={processingTimer} /> : null}
            <div className="simple-steps">
              {steps.map((step) => (
                <div className="simple-step" key={step.name}>
                  <StatusDot status={step.status} />
                  <span>{friendlyStepLabel(step.name)}</span>
                  <small>{friendlyStepDetail(step)}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="files-panel" aria-labelledby="files-title">
            <div className="panel-title-row">
              <div>
                <span className="section-kicker">Wyniki</span>
                <h2 id="files-title">Pliki sesji</h2>
              </div>
            </div>
            <div className="file-actions">
              <FileAction file={originalFile} label="Otwórz transkrypcję" detail="Oryginalny zapis rozmowy" />
              {translatedFiles.map(({ language, file }) => (
                <FileAction
                  key={language}
                  file={file}
                  label={`Otwórz tłumaczenie: ${languageMap[language]?.label ?? language.toUpperCase()}`}
                  detail={file ? `${formatBytes(file.size)} · zapis lokalny` : "Pojawi się po pierwszym fragmencie"}
                />
              ))}
            </div>
            <button className="copy-folder-button" onClick={copySessionFolder} disabled={!session?.dir} type="button">
              <FolderOpen size={18} />
              {folderCopied ? "Skopiowano folder" : "Kopiuj folder"}
            </button>
          </section>

          <details className="diagnostics-panel">
            <summary>
              <Settings size={18} />
              <span>Diagnostyka</span>
              <small>{healthSummary}</small>
            </summary>
            <button className="secondary-button" onClick={refreshHealth} type="button">
              <RefreshCw size={16} />
              Odśwież status
            </button>
            <div className="diagnostics-list">
              {health.map((item) => (
                <div className="diagnostic-row" key={item.name}>
                  <StatusDot status={item.ok ? "ok" : "error"} />
                  <div>
                    <strong>{technicalHealthLabel(item.name)}</strong>
                    <small>{item.detail}</small>
                  </div>
                  <span>{item.latencyMs ? `${item.latencyMs} ms` : item.ok ? "OK" : "Błąd"}</span>
                </div>
              ))}
            </div>
          </details>
        </aside>
      </main>

      <footer className="statusbar">
        <span>
          <Check size={16} />
          Działa lokalnie
        </span>
        <span>Sesja #{session?.sessionNumber ? String(session.sessionNumber).padStart(4, "0") : "-"}</span>
        <span>{rows.length === 1 ? "1 fragment" : `${rows.length} fragmentów`}</span>
      </footer>
    </div>
  );
}

function LanguageSelect({
  label,
  value,
  onChange,
  languages,
  exclude
}: {
  label: string;
  value: LanguageCode;
  onChange: (value: LanguageCode) => void;
  languages: LanguageOption[];
  exclude: LanguageCode;
}) {
  return (
    <label className="language-field">
      <span>{label}</span>
      <span className="language-select">
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as LanguageCode)}>
          {languages.map((language) => (
            <option key={language.code} value={language.code} disabled={language.code === exclude}>
              {language.label}
            </option>
          ))}
        </select>
        <ChevronDown size={16} />
      </span>
    </label>
  );
}

function EmptyConversation({ source, target }: { source: string; target: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Mic size={24} />
      </span>
      <h3>Gotowe do rozmowy</h3>
      <p>
        Wybierz języki, rozpocznij nagrywanie i mów w języku: {source}. Tłumaczenie na {target} oraz transkrypcja
        zapiszą się lokalnie w plikach sesji.
      </p>
    </div>
  );
}

function ErrorPanel({ message, onRefresh, onDismiss }: { message: string; onRefresh: () => void; onDismiss: () => void }) {
  return (
    <div className="error-panel" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>Wymaga uwagi</strong>
        <p>{message}</p>
      </div>
      <div className="error-actions">
        <button onClick={onRefresh} type="button">
          Odśwież status
        </button>
        <button onClick={onDismiss} type="button">
          Ukryj
        </button>
      </div>
    </div>
  );
}

function FileAction({ file, label, detail }: { file: SessionFile | undefined; label: string; detail: string }) {
  if (!file) {
    return (
      <div className="file-action disabled" aria-disabled="true">
        <FileText size={20} />
        <div>
          <span>{label}</span>
          <small>Jeszcze brak pliku</small>
        </div>
      </div>
    );
  }

  return (
    <a className="file-action" href={`/api/files/${file.name}`} target="_blank" rel="noreferrer">
      <FileText size={20} />
      <div>
        <span>{label}</span>
        <small>{detail}</small>
      </div>
    </a>
  );
}

function WaitTimer({ timer }: { timer: ProcessingTimer }) {
  return (
    <div className="wait-timer" aria-label={timerSummary(timer)}>
      <div className="wait-timer-main">
        <span>{timer.label}</span>
        <strong>{formatTimerMs(timer.elapsedMs)}</strong>
      </div>
      <div className="wait-progress" aria-hidden="true">
        <span style={{ width: `${Math.round((timer.progress ?? 0.08) * 100)}%` }} />
      </div>
      <small>{timerHint(timer)}</small>
    </div>
  );
}

function SegmentRow({
  segment,
  languageMap,
  loadingAudioKeys,
  activePlaybackKey,
  onRetry,
  onRetryAudio,
  onPlayOriginal,
  onPlayTranslation,
  timer
}: {
  segment: Segment;
  languageMap: Record<LanguageCode, LanguageOption>;
  loadingAudioKeys: Set<string>;
  activePlaybackKey: string | null;
  onRetry: () => void;
  onRetryAudio: () => void;
  onPlayOriginal: () => void;
  onPlayTranslation: () => void;
  timer?: ProcessingTimer | null;
}) {
  const language = segment.detectedLanguage ? languageMap[segment.detectedLanguage] : undefined;
  const targetLanguage = segment.targetLanguage ? languageMap[segment.targetLanguage] : undefined;
  const originalKey = `${segment.id}:original`;
  const translationKey = `${segment.id}:translation`;
  const originalLoading = loadingAudioKeys.has(originalKey);
  const translationLoading = loadingAudioKeys.has(translationKey);
  const originalPlaying = activePlaybackKey === originalKey;
  const translationPlaying = activePlaybackKey === translationKey;
  const translationTtsSupported = segment.targetLanguage ? Boolean(languageMap[segment.targetLanguage]?.ttsCode) : false;
  const translationPreparing = segment.status === "synthesizing";
  const translationAudioUnavailable = Boolean(segment.audioError);
  const translationHasRetryableAudioError = translationTtsSupported && translationAudioUnavailable;
  const warning = getSegmentWarning(segment, translationTtsSupported);

  return (
    <article className={`segment-card ${segment.status}`}>
      <header className="segment-meta">
        <time>{segment.displayTime}</time>
        <span className={`language-chip ${segment.detectedLanguage ?? "unknown"}`}>
          {language?.label ?? "Język w trakcie rozpoznania"}
        </span>
        <span className={`segment-status ${statusTone(segment.status)}`}>{statusText(segment.status)}</span>
        {timer ? (
          <span className="segment-timer" title={timerSummary(timer)}>
            Trwa {formatTimerMs(timer.elapsedMs)}
          </span>
        ) : null}
      </header>

      <div className="speech-grid">
        <AudioTextCell
          title="Oryginał"
          languageCode={segment.detectedLanguage}
          text={segment.originalText ?? statusPlaceholder(segment.status)}
          disabled={!segment.originalText}
          loading={originalLoading}
          playing={originalPlaying}
          playLabel="Odtwórz oryginał"
          stopLabel="Zatrzymaj oryginał"
          onPlay={onPlayOriginal}
        />
        <AudioTextCell
          title={targetLanguage ? `Tłumaczenie na ${targetLanguage.label}` : "Tłumaczenie"}
          languageCode={segment.targetLanguage}
          text={segment.translatedText ?? (segment.status === "error" ? segment.error : statusPlaceholder(segment.status))}
          disabled={!segment.translatedText || !translationTtsSupported || translationPreparing}
          loading={translationLoading || translationPreparing}
          playing={translationPlaying}
          playLabel={
            translationPreparing
              ? "Przygotowuję audio tłumaczenia"
              : translationHasRetryableAudioError
                ? "Spróbuj ponownie wygenerować audio"
                : translationTtsSupported
                  ? "Odtwórz tłumaczenie"
                  : "Audio niedostępne dla tego języka"
          }
          stopLabel="Zatrzymaj tłumaczenie"
          onPlay={onPlayTranslation}
        />
      </div>

      {warning ? (
        <div className="segment-warning">
          <AlertCircle size={16} />
          <span>{warning.message}</span>
          {warning.action === "segment" ? (
            <button onClick={onRetry} type="button">
              Spróbuj ponownie
            </button>
          ) : null}
          {warning.action === "audio" ? (
            <button onClick={onRetryAudio} type="button">
              Ponów audio
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function AudioTextCell({
  title,
  languageCode,
  text,
  disabled,
  loading,
  playing,
  playLabel,
  stopLabel,
  onPlay
}: {
  title: string;
  languageCode?: LanguageCode;
  text: string | undefined;
  disabled: boolean;
  loading: boolean;
  playing: boolean;
  playLabel: string;
  stopLabel: string;
  onPlay: () => void;
}) {
  const label = playing ? stopLabel : playLabel;

  return (
    <section className="speech-cell" aria-label={title}>
      <div className="speech-title-row">
        <h3>{title}</h3>
        <button
          className={`play-inline ${playing ? "playing" : ""}`}
          onClick={onPlay}
          disabled={disabled || loading}
          title={label}
          aria-label={label}
          type="button"
        >
          {loading ? (
            <RefreshCw className="spin" size={14} />
          ) : playing ? (
            <Square size={13} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
          <span>{playing ? "Stop" : loading ? "Czekaj" : "Odtwórz"}</span>
        </button>
      </div>
      <p dir={languageCode && isRtlLanguage(languageCode) ? "rtl" : "auto"}>{text}</p>
    </section>
  );
}

function StatusDot({ status }: { status: "idle" | "queued" | "active" | "ok" | "error" }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

function LevelMeter({ level }: { level: number }) {
  const bars = Array.from({ length: 28 }, (_, index) => index);
  const activeBars = Math.round(level * bars.length);
  return (
    <div className="level-meter" aria-label="Poziom mikrofonu">
      <div className="meter-labels">
        <span>Poziom mikrofonu</span>
        <small>{activeBars > 0 ? "Sygnał wykryty" : "Cisza"}</small>
      </div>
      <div className="bars">
        {bars.map((bar) => (
          <span key={bar} className={bar < activeBars ? "active" : ""} />
        ))}
      </div>
    </div>
  );
}

function getUserStatus(
  rows: Segment[],
  isRecording: boolean,
  isStartingRecording: boolean,
  error: string | null
): UserStatus {
  if (error || rows.some((segment) => segment.status === "error")) {
    return {
      label: "Wymaga uwagi",
      detail: "Sprawdź komunikat błędu i ponów nagrywanie albo fragment.",
      tone: "error"
    };
  }

  if (isStartingRecording) {
    return {
      label: "Nasłuchiwanie",
      detail: "Przygotowuję mikrofon i odtwarzanie audio.",
      tone: "active"
    };
  }

  if (isRecording) {
    return {
      label: "Nasłuchiwanie",
      detail: "Mikrofon działa. Po zatrzymaniu fragment trafi do tłumaczenia.",
      tone: "active"
    };
  }

  const activeSegment = [...rows].reverse().find((segment) => segment.status !== "done");
  if (activeSegment) {
    if (activeSegment.status === "transcribing" || activeSegment.status === "converting") {
      return { label: "Transkrypcja", detail: "Zamieniam nagranie na tekst.", tone: "active" };
    }
    if (activeSegment.status === "translating") {
      return { label: "Tłumaczenie", detail: "Przygotowuję tekst w drugim języku.", tone: "active" };
    }
    if (activeSegment.status === "synthesizing") {
      return { label: "Tworzenie audio", detail: "Tworzę głos dla tłumaczenia.", tone: "active" };
    }
    return { label: "Transkrypcja", detail: "Fragment czeka na przetworzenie.", tone: "idle" };
  }

  if (rows.length > 0) {
    return { label: "Gotowe", detail: "Ostatni fragment jest zapisany. Możesz odtworzyć tłumaczenie albo mówić dalej.", tone: "ok" };
  }

  return {
    label: "Gotowe",
    detail: "Wybierz języki i rozpocznij nagrywanie, gdy chcesz zacząć rozmowę.",
    tone: "ok"
  };
}

function getWaitTarget(rows: Segment[], isStartingRecording: boolean, isRecording: boolean): WaitTarget | null {
  if (isStartingRecording) {
    return {
      key: "recording:start",
      label: "Uruchamianie mikrofonu",
      timingKeys: []
    };
  }

  if (isRecording) {
    return null;
  }

  const activeSegment = [...rows].reverse().find((segment) => segment.status !== "done" && segment.status !== "error");
  if (!activeSegment) {
    return null;
  }

  const base = `${activeSegment.id}:${activeSegment.status}`;
  if (activeSegment.status === "queued") {
    return { key: base, label: "Czeka w kolejce", segmentId: activeSegment.id, timingKeys: [] };
  }
  if (activeSegment.status === "converting") {
    return { key: base, label: "Przygotowanie nagrania", segmentId: activeSegment.id, timingKeys: ["convert"] };
  }
  if (activeSegment.status === "transcribing") {
    return { key: base, label: "Transkrypcja", segmentId: activeSegment.id, timingKeys: ["transcribe"] };
  }
  if (activeSegment.status === "translating") {
    return { key: base, label: "Tłumaczenie tekstu", segmentId: activeSegment.id, timingKeys: ["translate"] };
  }
  if (activeSegment.status === "synthesizing") {
    return { key: base, label: "Tworzenie audio", segmentId: activeSegment.id, timingKeys: ["tts"] };
  }
  if (activeSegment.status === "writing") {
    return { key: base, label: "Zapis plików", segmentId: activeSegment.id, timingKeys: ["write"] };
  }

  return null;
}

function getProcessingTimer(target: WaitTarget, startedAtMs: number, nowMs: number, rows: Segment[]): ProcessingTimer {
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const estimatedMs = estimateTimingMs(rows, target.timingKeys);
  const remainingMs = estimatedMs ? Math.max(0, estimatedMs - elapsedMs) : undefined;
  const progress = estimatedMs ? Math.min(0.95, Math.max(0.06, elapsedMs / Math.max(estimatedMs, 1000))) : undefined;

  return {
    key: target.key,
    label: target.label,
    segmentId: target.segmentId,
    elapsedMs,
    estimatedMs,
    remainingMs,
    progress
  };
}

function estimateTimingMs(rows: Segment[], timingKeys: TimingKey[]) {
  const samples = rows
    .flatMap((segment) => timingKeys.map((key) => segment.timings[key]))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (samples.length === 0) {
    return undefined;
  }

  const middle = Math.floor(samples.length / 2);
  if (samples.length % 2 === 1) {
    return samples[middle];
  }
  return Math.round((samples[middle - 1] + samples[middle]) / 2);
}

function timerHint(timer: ProcessingTimer) {
  if (!timer.estimatedMs) {
    return "Mierzę czas tego etapu. Pierwsze wykonanie może potrwać dłużej.";
  }
  if (timer.remainingMs && timer.remainingMs > 1500) {
    return `Pozostało ok. ${formatTimerMs(timer.remainingMs)} · zwykle ${formatTimerMs(timer.estimatedMs)}`;
  }
  if (timer.elapsedMs > timer.estimatedMs + 1500) {
    return `Trwa dłużej niż zwykle (${formatTimerMs(timer.estimatedMs)}). Kończę etap.`;
  }
  return `Prawie gotowe · zwykle ${formatTimerMs(timer.estimatedMs)}`;
}

function timerSummary(timer: ProcessingTimer) {
  const estimate = timer.estimatedMs ? `, zwykle ${formatTimerMs(timer.estimatedMs)}` : "";
  const remaining = timer.remainingMs && timer.remainingMs > 0 ? `, pozostało około ${formatTimerMs(timer.remainingMs)}` : "";
  return `${timer.label}: trwa ${formatTimerMs(timer.elapsedMs)}${estimate}${remaining}`;
}

function getSegmentWarning(segment: Segment, translationTtsSupported: boolean) {
  if (segment.status === "error") {
    return {
      action: "segment" as const,
      message: segment.error ?? "Nie udało się przetworzyć tego fragmentu."
    };
  }

  if (!segment.audioError) {
    return null;
  }

  if (!translationTtsSupported) {
    return {
      action: "none" as const,
      message: "Tekst jest gotowy. Odtwarzanie głosowe nie jest dostępne dla tego języka."
    };
  }

  return {
    action: "audio" as const,
    message: "Tekst jest gotowy, ale audio wymaga ponowienia."
  };
}

function statusToneToStepStatus(tone: UserStatus["tone"]): "idle" | "active" | "ok" | "error" {
  if (tone === "error") return "error";
  if (tone === "active") return "active";
  if (tone === "ok") return "ok";
  return "idle";
}

function friendlyStepLabel(name: "Whisper" | "TranslateGemma" | "XTTS" | "Markdown") {
  const labels = {
    Whisper: "Rozpoznanie mowy",
    TranslateGemma: "Tłumaczenie tekstu",
    XTTS: "Głos tłumaczenia",
    Markdown: "Zapis rozmowy"
  };
  return labels[name];
}

function friendlyStepDetail(step: { status: "idle" | "queued" | "active" | "ok" | "error"; detail: string; latencyMs?: number }) {
  if (step.status === "active") return "W toku";
  if (step.status === "queued") return "Czeka";
  if (step.status === "ok") return step.latencyMs ? `${(step.latencyMs / 1000).toFixed(1)} s` : "Gotowe";
  if (step.status === "error") return "Błąd";
  return "Czeka";
}

function technicalHealthLabel(name: string) {
  const labels: Record<string, string> = {
    Bun: "Aplikacja",
    FFmpeg: "Format audio",
    "mlx-whisper": "Transkrypcja",
    "XTTS-v2": "Odtwarzanie głosu",
    "Ollama / TranslateGemma": "Tłumaczenie",
    "Folder sesji": "Folder sesji"
  };
  return labels[name] ?? name;
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function statusText(status: Segment["status"]) {
  const labels: Record<Segment["status"], string> = {
    queued: "Czeka",
    converting: "Przygotowanie",
    transcribing: "Transkrypcja",
    translating: "Tłumaczenie",
    synthesizing: "Tworzenie audio",
    writing: "Zapis",
    done: "Gotowe",
    error: "Błąd"
  };
  return labels[status];
}

function statusPlaceholder(status: Segment["status"]) {
  if (status === "done") return "Brak tekstu.";
  if (status === "error") return "Nie udało się przetworzyć fragmentu.";
  return `${statusText(status)}...`;
}

function statusTone(status: Segment["status"]) {
  if (status === "done") return "ok";
  if (status === "error") return "error";
  if (status === "queued") return "idle";
  return "active";
}

function isRtlLanguage(language: LanguageCode) {
  return language === "ar" || language === "fa" || language === "he";
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatTimerMs(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds >= 3600) {
    return formatDuration(totalSeconds);
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
