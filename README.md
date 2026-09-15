# Mind Browser

An AI-native desktop browser for macOS and Windows — a full Chromium browser with
five autonomous agents in the sidebar, a built-in News Hub and Finance Hub,
network-level ad and tracker blocking, and **your own models**.

There is no Mind Browser server. Bring an API key, or run everything offline
through [Ollama](https://ollama.com) and nothing leaves your machine.

**Website:** https://www.mindbrowser.tech

## Download

| Platform | Requirements | |
|---|---|---|
| **macOS** | Apple Silicon (M1+), macOS 12 or later | [Download](https://github.com/prakharsingh1/mind-browser/releases/latest/download/Mind-Browser-macOS-arm64.dmg) |
| **Windows** | x64, Windows 10 or 11 | [Download](https://github.com/prakharsingh1/mind-browser/releases/latest/download/Mind-Browser-Windows-x64.zip) |

Neither build is notarized (Apple charges $99/yr for that), so you get one
warning on first launch:

- **macOS**: open the .dmg, drag to Applications, then right click the app and
  choose **Open**, then **Open** again. Only needed the first time.
- **Windows**: SmartScreen, then **More info**, then **Run anyway**.

Full setup walkthrough: https://www.mindbrowser.tech/help.html

## What's in it

- **Five agents** — Planner, Navigator, Researcher, Writer, Analyst. Each gets its
  own model, so you can put a fast one on navigation and a strong one on planning.
- **News Hub** — six sections, a left/centre/right spectrum on every story, and a
  reader that merges every outlet covering it into one briefing with attribution intact.
- **Finance Hub** — quotes, indicators warmed up before the visible range so they're
  correct at the leftmost pixel, 11 fundamentals per company, and industry news
  sliced seven ways.
- **Shields** — ads, trackers and fingerprinters dropped at the network layer.
- **Onion Mode** — a window routed through a bundled Tor Expert Bundle, fetched
  and checksum-verified at build time by `scripts/fetch-tor.js`.
- **Bring your own model** — Ollama, Anthropic, OpenAI, Google, Groq, OpenRouter.

## Build from source

Requires Node 20+ and npm.

```bash
git clone https://github.com/prakharsingh1/mind-browser.git
cd mind-browser
npm install
npm run fetch-tor    # downloads + checksum-verifies the Tor Expert Bundle
npm start            # run it
npm run dist         # package for the current platform
```

Electron comes from the [castlabs build](https://github.com/castlabs/electron-releases)
so Widevine works. `resources/tor/` is not in the repo: `scripts/fetch-tor.js`
downloads the right bundle for your platform and verifies its checksum before
unpacking.

## Layout

```
main/            Electron main process
  agent/         the agent loop, tool schema and the five agents
renderer/        UI (no framework, plain modules)
scripts/         build-time helpers, incl. the Tor fetcher
build/           icons and macOS entitlements
```

## Licence

MIT, see [LICENSE](LICENSE).
