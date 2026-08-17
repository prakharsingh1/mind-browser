# Mind Browser

An AI-native desktop browser for macOS and Windows — a full Chromium browser with
five autonomous agents in the sidebar, a built-in News Hub and Finance Hub,
network-level ad and tracker blocking, and **your own models**.

There is no Mind Browser server. Bring an API key, or run everything offline
through [Ollama](https://ollama.com) and nothing leaves your machine.

**Website:** https://mind-browser-production.up.railway.app

## Download

| Platform | Requirements | |
|---|---|---|
| **macOS** | Apple Silicon (M1+), macOS 12 or later | [Download](https://github.com/prakharsingh1/mind-browser/releases/latest/download/Mind-Browser-macOS-arm64.zip) |
| **Windows** | x64, Windows 10 or 11 | [Download](https://github.com/prakharsingh1/mind-browser/releases/latest/download/Mind-Browser-Windows-x64.zip) |

Neither build is code-signed, so you get one warning on first launch:

- **macOS** — right-click the app → **Open** → Open
- **Windows** — SmartScreen → **More info** → **Run anyway**

Full setup walkthrough: https://mind-browser-production.up.railway.app/help

## What's in it

- **Five agents** — Planner, Navigator, Researcher, Writer, Analyst. Each gets its
  own model, so you can put a fast one on navigation and a strong one on planning.
- **News Hub** — six sections, a left/centre/right spectrum on every story, and a
  reader that merges every outlet covering it into one briefing with attribution intact.
- **Finance Hub** — quotes, indicators warmed up before the visible range so they're
  correct at the leftmost pixel, 11 fundamentals per company, and industry news
  sliced seven ways.
- **Shields** — ads, trackers and fingerprinters dropped at the network layer.
- **Bring your own model** — Ollama, Anthropic, OpenAI, Google, Groq, OpenRouter.

## Licence

MIT.
