# Tlumacz lokalny

Lokalny prototyp tlumacza rozmowy: Bun backend, React/Vite UI, `mlx-whisper` dla ASR i Ollama TranslateGemma dla tlumaczenia.

## Dokumentacja paper

Najpierw przeczytaj paper projektu. To glowny dokument dla osob, ktore chca
zrozumiec, uruchomic albo odtworzyc prototyp w innym srodowisku.

```text
+--------------------------------------------------------------+
| PAPER / GUIDE                                                |
|                                                              |
|  Architektura -> Pipeline -> Modele -> Wdrozenie             |
|                                                              |
|  docs/paper-prototyp-tlumacza-lokalnego.md                   |
+--------------------------------------------------------------+
```

Bezposredni link:
[paper-prototyp-tlumacza-lokalnego.md](docs/paper-prototyp-tlumacza-lokalnego.md)

## Uruchomienie

```bash
bun install
bun run dev
```

Frontend: `http://127.0.0.1:5173`  
Backend/API: `http://127.0.0.1:3000`

## Lokalne zaleznosci modeli

Domyslne sciezki i model:

- Whisper: `~/audio-ai/whisper-mlx/.venv/bin/mlx_whisper`
- Whisper model: `mlx-community/whisper-large-v3-mlx`
- Segment audio: do `600` sekund domyslnie. Jedno klikniecie nagrywania tworzy jeden dlugi fragment; aplikacja nie dzieli wypowiedzi na male kawalki.
- Ollama: `http://127.0.0.1:11434`
- TranslateGemma: `hf.co/mradermacher/translategemma-4b-it-GGUF:Q4_K_M`
- FFmpeg: `ffmpeg`
- XTTS: `~/audio-ai/xtts/.venv/bin/tts`
- XTTS worker Python: `~/audio-ai/xtts/.venv/bin/python`
- XTTS worker: `http://127.0.0.1:8765`

Mozna je nadpisac zmiennymi: `WHISPER_PATH`, `WHISPER_MODEL`, `SEGMENT_SECONDS`, `MAX_AUDIO_BYTES`, `OLLAMA_URL`, `OLLAMA_MODEL`, `FFMPEG_PATH`, `XTTS_PATH`, `XTTS_MODEL`, `XTTS_TIMEOUT_MS`, `XTTS_PYTHON`, `XTTS_WORKER_ENABLED`, `XTTS_WORKER_URL`, `XTTS_WORKER_TIMEOUT_MS`, `XTTS_DEVICE`, `SESSIONS_DIR`.

## Szybszy XTTS worker

`bun run dev` uruchamia lokalnego workera XTTS obok backendu i frontendu. Worker laduje model XTTS-v2 raz do pamieci, a kolejne segmenty sa wysylane do niego przez HTTP. Jezeli worker nie wystartuje albo zwroci blad, backend automatycznie wraca do wolniejszego trybu CLI `tts`.

Wymagane zaleznosci w venv XTTS:

```bash
uv pip install --python ~/audio-ai/xtts/.venv/bin/python fastapi uvicorn
```

Przydatne zmienne:

- `XTTS_WORKER_ENABLED=0` wylacza worker i uzywa tylko CLI.
- `XTTS_WORKER_URL=http://127.0.0.1:8765` ustawia adres workera.
- `XTTS_DEVICE=auto|cuda|mps|cpu` wybiera urzadzenie dla modelu; `auto` probuje CUDA, potem MPS, potem CPU.
- `XTTS_WORKER_TIMEOUT_MS=900000` ustawia limit czasu zapytania do workera.

## Pliki sesji

Kazda rozmowa zapisuje sie do folderu sesji, np. `sessions/20260623_sesja_0017_id_9d8a62fa/`:

- `original.md`
- `translated.<kod-jezyka>.md` dla obu wybranych jezykow, np. `translated.pl.md`, `translated.en.md`, `translated.ar.md`, `translated.vi.md`
- `segments.json`
- `audio/` z segmentami zrodlowymi i WAV dla Whispera
- `tts/` z wygenerowanymi plikami WAV dla odtwarzania tlumaczen

## Jezyki

Lista wyboru obejmuje teraz m.in. polski, angielski, niemiecki, hiszpanski, francuski, wloski, portugalski, niderlandzki, czeski, wegierski, turecki, ukrainski, rosyjski, arabski, chinski, japonski, koreanski, hindi, wietnamski, tajski, indonezyjski, malajski, tagalog, perski i hebrajski.

Transkrypcja i tlumaczenie dzialaja tekstowo dla calej listy. Lokalne odtwarzanie glosowe zalezy od kodow wspieranych przez XTTS; jezeli XTTS nie obsluguje danego jezyka lokalnie, aplikacja zostawia tekst tlumaczenia i blokuje przycisk audio dla tego segmentu.

Dla chinskiego XTTS wymaga dodatkowej paczki Python `pypinyin` w swoim venv:

```bash
uv pip install --python ~/audio-ai/xtts/.venv/bin/python pypinyin
```
