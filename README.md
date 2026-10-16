# Ember — Pi Theme & UI Extension

Ember is a warm, dark theme and a custom terminal UI for [Pi](https://pi.dev/). It combines a brown-black background and amber accents with a Tetris-inspired startup animation and a compact, information-rich interface.

## Preview

![Ember UI screenshot](assets/ember-preview.png)

### Startup animation

![Ember startup animation](assets/ember-intro.gif)

[Watch the startup animation as an MP4 video](assets/ember-intro.mp4)

## Features

- **Tetris-style startup animation** — the Pi logo assembles from colored pieces, pauses, then floats into the header.
- **Custom welcome header** — Pi version, model, context-window size, thinking level, loaded skills/prompts, and useful shortcuts.
- **Two-line footer** — project path, Git branch, LSP status when available, current model, context usage, thinking level, TTFT, and estimated generation speed.
- **Live activity status** — shows whether Pi is processing, thinking, generating, or running a tool.
- **Animated editor border** — a subtle Tetris-inspired line animation while the agent is working.
- **Context usage bar** — changes from cyan through yellow to coral as the context fills.
- **Responsive layout** — the header adapts to narrower terminals.

Ember is UI-only: it does not register tools, skills, prompt templates, or commands.

## Install

```bash
pi install npm:pi-ember-ui
```

Restart Pi after installing so the package's extension and theme are loaded.

## Theme behavior

On the first interactive startup after installing Ember, the extension selects the included `ember` theme and Pi saves it as the user's theme preference. A small marker is written to the Pi agent directory so this automatic selection happens only once.

After that first startup, users can freely select another theme in `/settings`. Ember will not force its palette again on later sessions or restarts. The marker is intentionally stored outside the package so updating or reinstalling the package does not normally reset the choice.

## Package contents

- `extensions/ember-ui.ts` — startup animation, header, footer, editor border, activity status, and performance measurements.
- `themes/ember.json` — Ember's color palette and theme tokens.
- `assets/ember-preview.png` — static screenshot used in this README and as the package gallery image.
- `assets/ember-intro.gif` — inline animated preview for GitHub.
- `assets/ember-intro.mp4` — video preview for the Pi package gallery.

## Compatibility

Ember is designed for Pi's interactive terminal UI (TUI). The startup animation is skipped in terminal environments where the extension detects that the custom intro is unsupported.

## Development

The extension imports these host-provided modules, which should be declared as `peerDependencies` rather than bundled:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

## License

Add the license you choose for this project before publishing.
