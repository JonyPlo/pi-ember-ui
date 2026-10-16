/**
 * ember-ui — UI extension for the "ember" theme.
 *
 * Features:
 * - Centered Tetris startup animation.
 * - Completed logo pauses for 1 second, then floats into the header position.
 * - Main header, footer and editor appear after the transition.
 * - Welcome header with Pi logo, model information and shortcuts.
 * - Two-line footer with project path, branch, LSP, model and context usage.
 * - Activity status embedded in the editor's top border.
 * - Tetris-line animation on the bottom input border while the agent works.
 * - Header, footer and input fade in once the logo lands in the header.
 * - Decode speed and TTFT measurements after each completed turn.
 *
 * UI-only: no tools, skills, commands or prompts are registered.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  CustomEditor,
  VERSION,
  type ContextUsage,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type MessageUpdateEvent,
  type ReadonlyFooterDataProvider,
  type Theme,
} from '@earendil-works/pi-coding-agent'
import {
  backgroundAnsi,
  foregroundAnsi,
  isAppleTerminalSession,
  mixColors,
  rgbColor,
  truncateToWidth,
  visibleWidth,
  type Color,
  type Component,
  type EditorTheme,
  type TerminalColorMode,
  type TUI,
} from '@earendil-works/pi-tui'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | 'idle'
  | 'prefill'
  | 'thinking'
  | 'generating'
  | 'toolcall'
  | 'tool'

type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

type StartupStage = 'warmup' | 'falling' | 'holding' | 'moving' | 'landing'

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const PULSE_INTERVAL_MS = 100

// Reveal: header / footer / input fade in after the intro logo has landed.
const REVEAL_MS = 700
const REVEAL_STAGGER_MS = 140 // footer and input start slightly later
const REVEAL_FRAME_MS = 33
const REVEAL_STEPS = 24 // fade is quantized so render caches stay useful

/**
 * Terminal background the fades blend towards. Fading to pure black would go
 * DARKER than the background and show up as a dark silhouette; blending to
 * the real background makes elements emerge cleanly from nothing.
 * (Sampled from the ember terminal: #0f0c0a. Adjust if you change themes.)
 */
const FADE_BG: readonly [number, number, number] = [15, 12, 10]

const RESET = '\x1b[0m'
const RESET_FG = '\x1b[39m'
const SEP = ' │ '

const HEADER_BOX_MAX = 110
const HEADER_WIDE_MIN = 104
const HEADER_FULL_MIN = 70
const HEADER_VERSION_ONLY_MAX = 40

// Startup animation timing.
const INTRO_INTERVAL_MS = 85
const INTRO_HOLD_MS = 1000
const INTRO_MOVE_DURATION_MS = 850
const INTRO_FRAME_MS = 30

/**
 * The intro runs on a "virtual clock" that never advances more than this per
 * frame. If the process stalls (event loop blocked, terminal not draining
 * output...), the animation resumes where it froze instead of skipping ahead.
 */
const INTRO_MAX_STEP_MS = 40

/**
 * Warm-up: some extensions do heavy synchronous work shortly after startup
 * (e.g. rpiv-ask-user-question pre-loads a ~560 ms module graph 2 s after it
 * loads), which freezes the whole process. Instead of letting that freeze
 * land in the middle of the Tetris animation, the intro waits on a blank
 * screen until it sees such a stall end, then starts. If no stall happens it
 * starts anyway after INTRO_WARMUP_MAX_MS.
 */
const INTRO_STALL_MS = 200
const INTRO_WARMUP_AFTER_STALL_MS = 120
const INTRO_WARMUP_MAX_MS = 2200
const INTRO_FADE_IN_MS = 400

/** Set EMBER_INTRO_DEBUG=1 to log stalls to <tmpdir>/ember-intro-debug.log. */
const INTRO_DEBUG = process.env.EMBER_INTRO_DEBUG === '1'
const INTRO_DEBUG_FILE = join(tmpdir(), 'ember-intro-debug.log')

interface TurnStats {
  ttftMs: number | null
  tokPerSec: number | null
  tokEstimated: boolean
  tokDash: boolean
}

interface TurnAccumulator {
  reqStart: number | null
  wallStart: number | null
  firstDeltaAt: number | null
  lastDeltaAt: number | null
  deltaCount: number
}

const S = {
  ctx: undefined as ExtensionContext | undefined,
  tui: undefined as TUI | undefined,

  streaming: false,
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  pulseTick: 0,
  /** pulseTick value when the current work session started. */
  lineStartTick: 0,

  /** Timestamp of the start of the reveal fade (0 = no reveal running). */
  revealStart: 0,
  revealTimer: undefined as ReturnType<typeof setInterval> | undefined,

  phase: 'idle' as Phase,
  phaseStart: 0,
  workStart: undefined as number | undefined,
  toolName: undefined as string | undefined,

  lastDurationMs: undefined as number | undefined,

  res: undefined as { skills: number; prompts: number } | undefined,

  branch: null as string | null,
  lastUsage: undefined as ContextUsage | undefined,
  lastTurn: undefined as TurnStats | undefined,
  turn: undefined as TurnAccumulator | undefined,
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function truncateMiddle(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s

  const chars = [...s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')]

  if (max <= 1) return '…'

  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head

  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}

function shortPath(p: string): string {
  const out = p.replace(/\\/g, '/')
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const h = home.replace(/\\/g, '/').replace(/\/+$/, '')

  if (h) {
    if (out === h) return '~'
    if (out.startsWith(h + '/')) return `~${out.slice(h.length)}`
  }

  return out
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n < 1000) return String(Math.round(n))

  const k = n / 1000
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function fmtRate(r: number): string {
  return r >= 10 ? r.toFixed(0) : r.toFixed(1)
}

function liveTheme(): Theme | undefined {
  return S.ctx?.ui.theme
}

// ---------------------------------------------------------------------------
// First-run Ember theme activation
// ---------------------------------------------------------------------------

const EMBER_THEME_MARKER = 'ember-ui-theme-initialized'

function getPiAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()

  if (!configured) {
    return join(homedir(), '.pi', 'agent')
  }

  const expanded =
    configured === '~'
      ? homedir()
      : configured.startsWith('~/') || configured.startsWith('~\\')
        ? join(homedir(), configured.slice(2))
        : configured

  return resolve(expanded)
}

/**
 * Select Ember only on the first interactive startup after installation.
 *
 * Pi persists the selected theme through ctx.ui.setTheme().
 * The separate marker prevents this extension from overriding a user's
 * theme choice on subsequent sessions and restarts.
 */
function applyEmberThemeOnFirstRun(ctx: ExtensionContext): void {
  if (ctx.mode !== 'tui' || !ctx.hasUI) {
    return
  }

  const agentDir = getPiAgentDir()
  const markerPath = join(agentDir, EMBER_THEME_MARKER)

  try {
    // A marker means the initial theme selection has already happened.
    if (existsSync(markerPath)) {
      return
    }

    // Wait until Pi has discovered the theme included in this package.
    const emberAvailable = ctx.ui
      .getAllThemes()
      .some((theme) => theme.name === 'ember')

    if (!emberAvailable) {
      return
    }

    // Store the marker outside the package so upgrades won't reset it.
    mkdirSync(agentDir, { recursive: true })

    writeFileSync(markerPath, 'Ember first-run theme selection completed.\n', {
      encoding: 'utf8',
      flag: 'wx',
    })
  } catch {
    // Without persistent state, don't risk overriding the user's theme
    // on every startup.
    return
  }

  const result = ctx.ui.setTheme('ember')

  if (!result.success) {
    // Allow another attempt if Pi could not activate the theme.
    try {
      unlinkSync(markerPath)
    } catch {
      // Ignore cleanup errors.
    }
  }
}

// ---------------------------------------------------------------------------
// Reveal (fade-in) helpers
// ---------------------------------------------------------------------------

/** Fade factor 0..1 (eased, quantized). 1 when no reveal is running. */
function revealAlpha(delayMs = 0): number {
  if (!S.revealStart) return 1

  const t = Math.max(
    0,
    Math.min(1, (Date.now() - S.revealStart - delayMs) / REVEAL_MS),
  )

  const eased = t * t * (3 - 2 * t)

  return Math.round(eased * REVEAL_STEPS) / REVEAL_STEPS
}

/**
 * Blend every truecolor SGR sequence in `s` towards the terminal background
 * (FADE_BG) by (1 - alpha).
 * Text without explicit color gets a faded default foreground. 256-color and
 * 16-color sequences are left untouched (they simply don't fade).
 */
function fadeAnsi(s: string, alpha: number): string {
  if (alpha >= 1 || s.length === 0) return s

  const a = Math.max(0, alpha)

  // Blend a channel from the background towards its real value.
  const mix = (value: number, bg: number): number =>
    Math.round(bg + (value - bg) * a)

  const defaultFg = `\x1b[38;2;${mix(214, FADE_BG[0])};${mix(
    204,
    FADE_BG[1],
  )};${mix(194, FADE_BG[2])}m`

  const body = s.replace(/\x1b\[([0-9;]*)m/g, (_m: string, params: string) => {
    if (params === '' || params === '0' || params === '39') {
      // Reset / default foreground: keep the faded default afterwards.
      return `\x1b[${params}m${defaultFg}`
    }

    const p = params.split(';')
    const res: string[] = []

    for (let i = 0; i < p.length; i++) {
      const code = p[i]!

      if (
        (code === '38' || code === '48') &&
        p[i + 1] === '2' &&
        i + 4 < p.length
      ) {
        res.push(
          code,
          '2',
          String(mix(Number(p[i + 2]), FADE_BG[0])),
          String(mix(Number(p[i + 3]), FADE_BG[1])),
          String(mix(Number(p[i + 4]), FADE_BG[2])),
        )
        i += 4
      } else if (
        (code === '38' || code === '48') &&
        p[i + 1] === '5' &&
        i + 2 < p.length
      ) {
        res.push(code, '5', p[i + 2]!)
        i += 2
      } else {
        res.push(code)
      }
    }

    return `\x1b[${res.join(';')}m`
  })

  return defaultFg + body + '\x1b[39m'
}

function stopReveal(): void {
  if (S.revealTimer) {
    clearInterval(S.revealTimer)
    S.revealTimer = undefined
  }

  S.revealStart = 0
}

function startReveal(): void {
  stopReveal()

  S.revealStart = Date.now()

  S.revealTimer = setInterval(() => {
    const elapsed = Date.now() - S.revealStart

    if (elapsed >= REVEAL_MS + REVEAL_STAGGER_MS + REVEAL_FRAME_MS) {
      stopReveal()
    }

    S.tui?.requestRender()
  }, REVEAL_FRAME_MS)

  S.revealTimer.unref?.()
}

// ---------------------------------------------------------------------------
// Pi logo and color palette
// ---------------------------------------------------------------------------

const LOGO_CORAL = rgbColor(228, 138, 122)
const LOGO_BLUE = rgbColor(79, 142, 179)
const LOGO_YELLOW = rgbColor(234, 182, 93)
const LOGO_CYAN = rgbColor(135, 206, 212)

const WHITE = rgbColor(255, 255, 255)
const BLACK = rgbColor(0, 0, 0)

const LOGO_PIXELS = [
  ['c', 'c', 'c', '.'],
  ['b', '.', 'c', '.'],
  ['b', 'b', '.', 'y'],
  ['b', '.', '.', 'y'],
] as const

/** One logo pixel / Tetris cell = 4 columns x 2 rows. */
const CELL_W = 4
const CELL_H = 2
const GRID_COLS = 6
const GRID_ROWS = 5

const LOGO_CELL_COUNT = GRID_COLS * CELL_W
const LOGO_ROWS = GRID_ROWS * CELL_H

interface Piece {
  key: 'i' | 'b' | 'c' | 'y'
  color: Color
  cells: ReadonlyArray<readonly [number, number]>
}

const PIECES: readonly Piece[] = [
  {
    key: 'i',
    color: LOGO_CYAN,
    cells: [
      [4, 0],
      [4, 1],
      [4, 2],
      [4, 3],
    ],
  },
  {
    key: 'b',
    color: LOGO_BLUE,
    cells: [
      [1, 1],
      [2, 1],
      [3, 1],
      [2, 2],
    ],
  },
  {
    key: 'c',
    color: LOGO_CORAL,
    cells: [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 3],
    ],
  },
  {
    key: 'y',
    color: LOGO_YELLOW,
    cells: [
      [2, 4],
      [3, 4],
      [4, 4],
      [4, 5],
    ],
  },
]

/**
 * Intro timing, measured in ticks (1 tick = INTRO_INTERVAL_MS).
 *
 * Pieces spawn in "headroom" rows ABOVE the logo canvas and fall one grid row
 * per tick. The headroom is what keeps every piece visible for its whole
 * fall, including pieces whose final position is at the very top of the logo
 * (the coral one). Without it they would fall while clipped off-canvas and
 * pop in only at the last moment.
 */
const MAX_HEADROOM = 3
const LEAD_IN_TICKS = 2
const LANDING_GAP_TICKS = 1
const FLASH_TICKS = 6
const CLEAR_STEPS = 3

interface Timeline {
  headroom: number
  schedule: ReadonlyArray<{
    start: number
    land: number
    fall: number
  }>
  flashStart: number
  clearStart: number
  settleTick: number
  smoothTick: number
  end: number
}

function buildTimeline(headroom: number): Timeline {
  let t = LEAD_IN_TICKS

  const schedule = PIECES.map((p) => {
    // Spawn with the topmost cell on the first headroom row.
    const minRow = Math.min(...p.cells.map(([r]) => r))
    const fall = minRow + headroom

    const start = t
    const land = start + fall

    t = land + LANDING_GAP_TICKS

    return { start, land, fall }
  })

  const flashStart = schedule[schedule.length - 1]!.land + 1
  const clearStart = flashStart + FLASH_TICKS
  const settleTick = clearStart + CLEAR_STEPS
  const smoothTick = settleTick + 1

  return {
    headroom,
    schedule,
    flashStart,
    clearStart,
    settleTick,
    smoothTick,
    end: smoothTick + 1,
  }
}

interface Glyph {
  ch: string
  fg?: Color
  bg?: Color
}

// ---------------------------------------------------------------------------
// Shared logo renderer
// ---------------------------------------------------------------------------

/**
 * Optional decoration drawn around the intro logo: an empty Tetris "well"
 * (walls + floor) and a caption underneath. Both are completely static on
 * purpose: they have to look right even while the process is frozen.
 */
interface LogoDeco {
  /** 0..1 */
  wellAlpha: number
  /** 0..1 */
  captionAlpha: number
}

const WELL_COLOR = rgbColor(112, 98, 90)
const CAPTION_COLOR = rgbColor(150, 134, 122)
const CAPTION_TEXT = 'starting…'

/** Extra canvas columns / rows the decoration needs. */
const WELL_SIDE = 1
const WELL_BELOW_ROWS = 3 // floor, blank, caption

/**
 * tick = null -> completed, stationary logo (canvas is LOGO_ROWS tall).
 * tick = n    -> intro frame n. The canvas is taller by tl.headroom grid
 *                rows at the top, so falling pieces are visible from spawn.
 */
function emberLogoLines(
  mode: TerminalColorMode,
  tick: number | null,
  tl: Timeline = buildTimeline(MAX_HEADROOM),
  deco?: LogoDeco,
): string[] {
  const headroom = tick == null ? 0 : tl.headroom
  const oy = headroom * CELL_H

  // With decoration the canvas is WELL_SIDE columns wider on each side and
  // WELL_BELOW_ROWS taller; everything else is shifted by (ox, 0).
  const ox = deco ? WELL_SIDE : 0

  const H = LOGO_ROWS + oy // content rows
  const W = LOGO_CELL_COUNT + ox * 2
  const totalRows = H + (deco ? WELL_BELOW_ROWS : 0)

  const g: Array<Array<Glyph | null>> = Array.from({ length: totalRows }, () =>
    Array<Glyph | null>(W).fill(null),
  )

  const put = (row: number, col: number, glyph: Glyph) => {
    if (row >= 0 && row < totalRows && col >= 0 && col < W) {
      g[row]![col] = glyph
    }
  }

  if (deco) {
    if (deco.wellAlpha > 0.02) {
      const wc = mixColors(
        WELL_COLOR,
        rgbColor(FADE_BG[0], FADE_BG[1], FADE_BG[2]),
        1 - clamp(deco.wellAlpha, 0, 1),
        'srgb',
      )

      // Walls and floor are all drawn at the very EDGE of their cells
      // ("▏" left edge, "▕" right edge, "▔" top edge), so they meet in
      // exact corners and the floor sits flush under the last piece row.
      // (The usual "│" / "─" are drawn in the middle of their cells, which
      // leaves half a cell of empty space or misaligned corners.)
      // The floor is a bit thicker than the walls, so it is dimmed slightly
      // to look the same weight.
      const floor = mixColors(
        wc,
        rgbColor(FADE_BG[0], FADE_BG[1], FADE_BG[2]),
        0.3,
        'srgb',
      )

      for (let r = 0; r < H; r++) {
        put(r, 0, { ch: '▏', fg: wc })
        put(r, W - 1, { ch: '▕', fg: wc })
      }

      for (let c = 0; c < W; c++) {
        put(H, c, { ch: '▔', fg: floor })
      }
    }

    if (deco.captionAlpha > 0.02) {
      const cc = mixColors(
        CAPTION_COLOR,
        rgbColor(FADE_BG[0], FADE_BG[1], FADE_BG[2]),
        1 - clamp(deco.captionAlpha, 0, 1),
        'srgb',
      )

      const chars = [...CAPTION_TEXT]
      const start = Math.floor((W - chars.length) / 2)

      chars.forEach((ch, i) => {
        put(H + 2, start + i, { ch, fg: cc })
      })
    }
  }

  const smooth = tick == null || tick >= tl.smoothTick

  if (smooth) {
    for (let r = 0; r < LOGO_PIXELS.length; r++) {
      const prow = LOGO_PIXELS[r]!

      for (let c = 0; c < prow.length; c++) {
        const k = prow[c]!

        if (k === '.') continue

        const color =
          k === 'c' ? LOGO_CORAL : k === 'b' ? LOGO_BLUE : LOGO_YELLOW

        for (let dr = 0; dr < CELL_H; dr++) {
          for (let dc = 0; dc < CELL_W; dc++) {
            put(oy + (r + 1) * CELL_H + dr, ox + (c + 1) * CELL_W + dc, {
              ch: '█',
              fg: color,
            })
          }
        }
      }
    }
  } else {
    const t = tick!
    const settled = t >= tl.settleTick

    const flashOn =
      t >= tl.flashStart && t < tl.clearStart && (t - tl.flashStart) % 2 === 0

    // The completed line is cleared from the center outwards.
    const clearProgress = t - tl.clearStart

    const isCleared = (col: number): boolean => {
      if (clearProgress < 0) return false

      const dist = col <= 2 ? 2 - col : col - 3
      return dist <= clearProgress
    }

    PIECES.forEach((piece, i) => {
      const sch = tl.schedule[i]!

      if (t < sch.start) return

      const d = Math.max(0, sch.fall - (t - sch.start))
      const justLanded = t === sch.land

      for (const [cr, cc] of piece.cells) {
        const onLine = cr === GRID_ROWS - 1

        if (onLine && isCleared(cc)) continue

        const row = cr + (settled ? 1 : 0) - d + headroom

        if (row < 0 || row >= GRID_ROWS + headroom) continue

        let base = piece.color

        if (flashOn && onLine) {
          base = mixColors(piece.color, WHITE, 0.65, 'srgb')
        } else if (justLanded) {
          // Brief "lock" highlight on the tick a piece touches down.
          base = mixColors(piece.color, WHITE, 0.3, 'srgb')
        }

        const edge = mixColors(base, BLACK, 0.22, 'srgb')

        const tr = row * CELL_H
        const tc = ox + cc * CELL_W

        for (let x = 0; x < CELL_W; x++) {
          put(tr, tc + x, { ch: '█', fg: edge })
        }

        for (let x = 0; x < CELL_W; x++) {
          put(tr + 1, tc + x, { ch: '█', fg: base })
        }
      }
    })
  }

  return g.map((row) => {
    let line = ''
    let cur = ''

    for (const cell of row) {
      const ansi = cell
        ? (cell.bg ? backgroundAnsi(cell.bg, mode) : '') +
          (cell.fg ? foregroundAnsi(cell.fg, mode) : '')
        : ''

      if (ansi !== cur) {
        line += (cur ? RESET : '') + ansi
        cur = ansi
      }

      line += cell ? cell.ch : ' '
    }

    return cur ? line + RESET : line
  })
}

function piWordmarkEmber(theme: Theme): string {
  return (
    theme.style('π', { fg: theme.colors.accent }) +
    ' ' +
    theme.style('pi', {
      bold: true,
      fg: theme.colors.text,
    })
  )
}

// ---------------------------------------------------------------------------
// Startup positioning helpers
// ---------------------------------------------------------------------------

interface Position {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Return the origin of the 24-column logo canvas inside the final header.
 *
 * Wide header:
 *   row 0 = top border
 *   row 1 = first content row
 *
 * Compact bordered header:
 *   row 0 = top border
 *   row 1 = blank padding row
 *   row 2 = first content row
 *
 * Narrow layouts without the bordered logo have no destination.
 */
function getHeaderLogoPosition(width: number): Position | null {
  if (width < HEADER_FULL_MIN || isAppleTerminalSession()) {
    return null
  }

  return {
    x: 3,
    y: width >= HEADER_WIDE_MIN ? 1 : 2,
  }
}

function drawLogoAt(
  logo: string[],
  width: number,
  height: number,
  x: number,
  y: number,
): string[] {
  const lines = Array.from({ length: Math.max(1, height) }, () => '')

  const maxX = Math.max(0, width - LOGO_CELL_COUNT)
  const safeX = clamp(Math.round(x), 0, maxX)
  const safeY = Math.round(y)

  for (let i = 0; i < logo.length; i++) {
    const row = safeY + i

    if (row < 0 || row >= lines.length) continue

    const available = Math.max(0, width - safeX)

    const visibleLogo =
      visibleWidth(logo[i]!) > available
        ? truncateToWidth(logo[i]!, available, '')
        : logo[i]!

    lines[row] = ' '.repeat(safeX) + visibleLogo
  }

  return lines
}

// ---------------------------------------------------------------------------
// Full-screen startup intro
// ---------------------------------------------------------------------------

class EmberStartupIntro implements Component {
  private stage: StartupStage = 'warmup'
  private tick = 0

  // Virtual clock (ms since the intro started), see INTRO_MAX_STEP_MS.
  private clockNow = 0
  private lastReal = Date.now()
  private readonly realStart = Date.now()
  private lastRenderReal = 0
  private debugLines: string[] = []

  private stageStartedAt = 0

  private timer: ReturnType<typeof setInterval> | undefined

  private lastWidth = 80

  private moveStart: Position = { x: 0, y: 0 }
  private moveTarget: Position | null = null

  private finished = false

  private stallEndedAt = 0

  private readonly tl: Timeline

  constructor(
    private tui: TUI,
    private theme: Theme,
    private done: () => void,
  ) {
    // Use as much headroom above the logo as this terminal can show, so the
    // pieces are visible during their entire fall.
    const rows = this.terminalHeight()
    const centerY = Math.max(0, Math.floor((rows - LOGO_ROWS) / 2))

    this.tl = buildTimeline(
      clamp(Math.floor(centerY / CELL_H), 1, MAX_HEADROOM),
    )

    // Render at approximately 33 FPS. The Tetris cells themselves advance
    // every 85 ms, while the later movement uses this faster frame clock.
    this.timer = setInterval(() => this.advance(), INTRO_FRAME_MS)

    this.timer.unref?.()
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private debug(msg: string): void {
    if (!INTRO_DEBUG) return

    this.debugLines.push(`+${Date.now() - this.realStart}ms ${msg}`)
  }

  private flushDebug(): void {
    if (!INTRO_DEBUG || this.debugLines.length === 0) return

    try {
      appendFileSync(
        INTRO_DEBUG_FILE,
        `--- intro run ${new Date().toISOString()} ---\n` +
          this.debugLines.join('\n') +
          '\n',
      )
    } catch {
      // Debug logging must never break the UI.
    }
  }

  private finish(): void {
    if (this.finished) return

    this.finished = true
    this.stop()
    this.flushDebug()
    this.done()
  }

  private terminalHeight(): number {
    return Math.max(1, this.tui.terminal.rows || 24)
  }

  private centerPosition(width: number, height: number): Position {
    return {
      x: Math.max(0, Math.floor((width - LOGO_CELL_COUNT) / 2)),
      y: Math.max(0, Math.floor((height - LOGO_ROWS) / 2)),
    }
  }

  private beginMovement(now: number): void {
    const width = this.lastWidth
    const height = this.terminalHeight()

    const target = getHeaderLogoPosition(width)

    // For narrow or unsupported terminal layouts, the finished logo has no
    // matching header canvas to fly into, so end cleanly after the pause.
    if (!target) {
      this.finish()
      return
    }

    this.moveStart = this.centerPosition(width, height)
    this.moveTarget = target

    this.stage = 'moving'
    this.stageStartedAt = now

    this.tui.requestRender()
  }

  private advance(): void {
    if (this.finished) return

    const real = Date.now()
    const realDt = real - this.lastReal
    this.lastReal = real

    // Gap between timer callbacks far above INTRO_FRAME_MS = event loop was
    // blocked by something else in the process.
    if (realDt > 120) {
      this.debug(
        `event loop stalled ${realDt}ms (stage=${this.stage} tick=${this.tick})`,
      )
    }

    this.clockNow += Math.min(realDt, INTRO_MAX_STEP_MS)

    const now = this.clockNow

    if (this.stage === 'warmup') {
      if (realDt > INTRO_STALL_MS) this.stallEndedAt = real

      const stallPassed =
        this.stallEndedAt > 0 &&
        real - this.stallEndedAt >= INTRO_WARMUP_AFTER_STALL_MS

      const timedOut = real - this.realStart >= INTRO_WARMUP_MAX_MS

      // Keep repainting while the well fades in.
      if (real - this.realStart <= INTRO_FADE_IN_MS + INTRO_FRAME_MS) {
        this.tui.requestRender()
      }

      if (stallPassed || timedOut) {
        this.debug(
          stallPassed
            ? 'warm-up done: stall observed and finished'
            : 'warm-up done: timeout, no stall observed',
        )

        this.stage = 'falling'
        this.stageStartedAt = now
        this.tui.requestRender()
      }

      return
    }

    if (this.stage === 'falling') {
      const elapsed = now - this.stageStartedAt

      const nextTick = Math.min(
        this.tl.end,
        Math.floor(elapsed / INTRO_INTERVAL_MS),
      )

      if (nextTick !== this.tick) {
        this.tick = nextTick
        this.tui.requestRender()
      }

      if (nextTick >= this.tl.end) {
        // The Tetris sequence is complete. Keep the finished logo centered.
        this.tick = this.tl.end
        this.stage = 'holding'
        this.stageStartedAt = now
        this.tui.requestRender()
      }

      return
    }

    if (this.stage === 'holding') {
      if (now - this.stageStartedAt >= INTRO_HOLD_MS) {
        this.beginMovement(now)
      }

      return
    }

    if (this.stage === 'moving') {
      if (now - this.stageStartedAt >= INTRO_MOVE_DURATION_MS) {
        // Render at the exact destination before revealing the main UI.
        this.stage = 'landing'
        this.stageStartedAt = now
      }

      this.tui.requestRender()
      return
    }

    if (this.stage === 'landing') {
      // One frame at the destination prevents the logo from jumping at the
      // very end of its movement.
      this.finish()
    }
  }

  invalidate(): void {}

  dispose(): void {
    this.stop()
  }

  render(width: number): string[] {
    this.lastWidth = width

    if (INTRO_DEBUG) {
      const real = Date.now()

      if (this.lastRenderReal && real - this.lastRenderReal > 150) {
        this.debug(
          `render gap ${real - this.lastRenderReal}ms (stage=${this.stage} tick=${this.tick})`,
        )
      }

      this.lastRenderReal = real
    }

    const height = this.terminalHeight()
    const mode = this.theme.getColorMode()

    const centered = this.centerPosition(width, height)

    let logoTick: number | null = this.tick
    let deco: LogoDeco | undefined
    let x = centered.x
    let y = centered.y

    if (this.stage === 'warmup') {
      // Empty well + caption, fading in. Fully static after ~0.4 s, so a
      // process freeze while waiting looks intentional, not like a hang.
      const fade = clamp((Date.now() - this.realStart) / INTRO_FADE_IN_MS, 0, 1)

      logoTick = -1
      deco = { wellAlpha: fade, captionAlpha: fade }
    } else if (this.stage === 'falling') {
      // Logo pieces are assembled in the center of the otherwise empty screen.
      logoTick = Math.min(this.tick, this.tl.end)

      // The caption fades out as the first piece spawns; the well fades out
      // while the completed line flashes and clears.
      deco = {
        captionAlpha: clamp(1 - this.tick / 3, 0, 1),
        wellAlpha:
          1 -
          clamp(
            (this.tick - this.tl.flashStart) /
              (this.tl.settleTick - this.tl.flashStart),
            0,
            1,
          ),
      }
    } else {
      // After the Tetris sequence, render the completed logo as one object.
      logoTick = null
    }

    if (
      (this.stage === 'moving' || this.stage === 'landing') &&
      this.moveTarget
    ) {
      if (this.stage === 'landing') {
        x = this.moveTarget.x
        y = this.moveTarget.y
      } else {
        const rawProgress = clamp(
          (this.clockNow - this.stageStartedAt) / INTRO_MOVE_DURATION_MS,
          0,
          1,
        )

        // Ease-in-out cubic: leaves the center gently and settles softly
        // into the header (an ease-out alone starts with an abrupt jump).
        const eased =
          rawProgress < 0.5
            ? 4 * rawProgress ** 3
            : 1 - Math.pow(-2 * rawProgress + 2, 3) / 2

        x = this.moveStart.x + (this.moveTarget.x - this.moveStart.x) * eased

        // Add a tiny upward arc so the logo feels like it floats into place.
        const floatArc = Math.sin(rawProgress * Math.PI) * 1.25

        y =
          this.moveStart.y +
          (this.moveTarget.y - this.moveStart.y) * eased -
          floatArc
      }
    }

    const logo = emberLogoLines(mode, logoTick, this.tl, deco)

    // While falling, the canvas has extra rows on top: shift it up so the
    // logo area itself stays exactly at the centered position.
    const yOffset = logoTick == null ? 0 : this.tl.headroom * CELL_H

    return drawLogoAt(
      logo,
      width,
      height,
      x - (deco ? WELL_SIDE : 0),
      y - yOffset,
    )
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['/model', 'switch model'],
  ['/compact', 'summarize and free context'],
  ['/new', 'start a new session'],
  ['/', 'see all commands'],
  ['!', 'run a bash command'],
  ['esc', 'interrupt the agent'],
  ['ctrl+c / d', 'clear / exit'],
]

const KEY_W = 12
const INFO_W = 30

class EmberHeader implements Component {
  private lastKey = ''
  private lastLines: string[] = []

  constructor(tui: TUI) {
    S.tui = S.tui ?? tui
  }

  invalidate(): void {
    this.lastKey = ''
  }

  private buildVersionSeg(theme: Theme): string {
    return `${piWordmarkEmber(theme)} ${theme.style(`v${VERSION}`, {
      fg: theme.colors.dim,
    })}`
  }

  /** Under 40 columns: version only. */
  private buildVersionOnly(theme: Theme, width: number): string {
    let line = this.buildVersionSeg(theme)

    if (visibleWidth(line) > width) {
      line = truncateMiddle(line, width)
    }

    return line
  }

  /** 70+ columns: bordered welcome box. */
  private buildBox(theme: Theme, width: number, alpha: number): string[] {
    // The logo is already on screen (the intro drew it at this exact spot),
    // so only the surrounding box and text fade in.
    const fd = (t: string) => fadeAnsi(t, alpha)

    const ctx = S.ctx
    const model = ctx?.model

    // The intro already assembled the logo. Keep it static in the header.
    const logo = emberLogoLines(theme.getColorMode(), null)

    const boxW = Math.min(width, HEADER_BOX_MAX)
    const inner = boxW - 2

    const PAD = 2
    const GAP = 3

    const wide = boxW >= HEADER_WIDE_MIN

    const dim = (t: string) => theme.style(t, { fg: theme.colors.dim })

    const muted = (t: string) => theme.style(t, { fg: theme.colors.muted })

    const accent = (t: string, bold = false) =>
      theme.style(t, {
        fg: theme.colors.accent,
        bold,
      })

    const b = (t: string) => theme.style(t, { fg: theme.colors.border })

    const label = (t: string) => dim(t.padEnd(7))

    const info: string[] = [this.buildVersionSeg(theme), '']

    if (model) {
      info.push(
        `${accent('●')} ${theme.style(model.id, {
          fg: theme.colors.text,
        })}`,
      )

      if (Number.isFinite(model.contextWindow)) {
        info.push(
          `${label('ctx')}${muted(`${fmtTokens(model.contextWindow)} tokens`)}`,
        )
      }
    }

    const level = (ctx?.thinkingLevel ?? 'off') as ThinkingLevel

    info.push(
      `${label('think')}${theme.style(level, {
        fg: theme.colors[THINKING_TOKEN[level]],
      })}`,
    )

    if (ctx) {
      info.push(`${label('cwd')}${muted(shortPath(ctx.cwd))}`)
    }

    if (S.res) {
      info.push(
        `${label('loaded')}${muted(
          `${S.res.skills} skills · ${S.res.prompts} prompts`,
        )}`,
      )
    }

    const shortRow = (k: string, d: string) =>
      `${accent(k.padEnd(KEY_W))}${muted(d)}`

    const shortcuts: string[] = [
      accent('shortcuts', true),
      ...SHORTCUTS.map(([k, d]) => shortRow(k, d)),
    ]

    const fit = (t: string, w: number) => {
      const cut = visibleWidth(t) > w ? truncateMiddle(t, w) : t

      return cut + ' '.repeat(Math.max(0, w - visibleWidth(cut)))
    }

    const sp = (n: number) => ' '.repeat(Math.max(0, n))

    const out: string[] = [fd(b('╭' + '─'.repeat(inner) + '╮'))]

    const blank = fd(b('│')) + sp(inner) + fd(b('│'))

    if (wide) {
      const shortW = inner - PAD * 2 - LOGO_CELL_COUNT - GAP - INFO_W - 3

      const bodyH = Math.max(logo.length, 2 + info.length, 2 + shortcuts.length)

      const infoOff = 2 + Math.floor((LOGO_ROWS - 2 - info.length) / 2)

      const shortOff = 2 + Math.floor((LOGO_ROWS - 2 - shortcuts.length) / 2)

      // Keep the vertical separator confined to the actual content.
      // Its three-character slot remains reserved on every row.
      const dividerStart = Math.min(infoOff, shortOff)

      const dividerEnd = Math.max(
        infoOff + info.length,
        shortOff + shortcuts.length,
      )

      for (let r = 0; r < bodyH; r++) {
        const l = logo[r] ?? ''
        const i = info[r - infoOff] ?? ''
        const k = shortcuts[r - shortOff] ?? ''

        const divider =
          r >= dividerStart && r < dividerEnd ? ` ${b('│')} ` : '   '

        out.push(
          fd(b('│')) +
            sp(PAD) +
            fit(l, LOGO_CELL_COUNT) +
            sp(GAP) +
            fd(fit(i, INFO_W) + divider + fit(k, shortW)) +
            sp(PAD) +
            fd(b('│')),
        )
      }

      out.push(blank, blank)
    } else {
      const infoW = inner - PAD * 2 - LOGO_CELL_COUNT - GAP

      const col = [...info, '', ...shortcuts.slice(1, 3)]

      const bodyH = Math.max(logo.length, col.length)

      out.push(blank)

      for (let r = 0; r < bodyH; r++) {
        const l = logo[r] ?? ''
        const c = col[r] ?? ''

        out.push(
          fd(b('│')) +
            sp(PAD) +
            fit(l, LOGO_CELL_COUNT) +
            sp(GAP) +
            fd(fit(c, infoW)) +
            sp(PAD) +
            fd(b('│')),
        )
      }

      out.push(blank)
    }

    out.push(fd(b('╰' + '─'.repeat(inner) + '╯')))

    return out
  }

  /** 40–69 columns: a compact line. */
  private buildCompact(theme: Theme, width: number): string {
    const ctx = S.ctx
    const model = ctx?.model

    const dot = theme.style('·', {
      fg: theme.colors.dim,
    })

    let line = this.buildVersionSeg(theme)

    if (model) {
      line += ` ${dot} ${theme.style(model.id, {
        fg: theme.colors.text,
      })}`
    }

    if (ctx) {
      line += ` ${dot} ${theme.style(shortPath(ctx.cwd), {
        fg: theme.colors.muted,
      })}`
    }

    if (visibleWidth(line) > width) {
      line = this.buildVersionSeg(theme)

      if (model) {
        line += ` ${dot} ${theme.style(model.id, {
          fg: theme.colors.text,
        })}`
      }
    }

    if (visibleWidth(line) > width) {
      line = this.buildVersionSeg(theme)
    }

    if (visibleWidth(line) > width) {
      line = truncateMiddle(line, width)
    }

    return line
  }

  render(width: number): string[] {
    const theme = liveTheme()

    if (!S.ctx || !theme) return ['']

    const supports = !isAppleTerminalSession()

    let bucket: number

    if (width < HEADER_VERSION_ONLY_MAX) {
      bucket = 0
    } else if (width < HEADER_FULL_MIN || !supports) {
      bucket = 1
    } else {
      bucket = 2
    }

    const ctx = S.ctx
    const model = ctx.model

    const alpha = revealAlpha(0)

    const key = [
      alpha,
      bucket,
      width,
      model?.id ?? '',
      model && Number.isFinite(model.contextWindow) ? model.contextWindow : 0,
      shortPath(ctx.cwd),
      ctx.thinkingLevel ?? '',
      S.res ? `${S.res.skills}/${S.res.prompts}` : '',
    ].join('|')

    if (key === this.lastKey && this.lastLines.length > 0) {
      return this.lastLines
    }

    this.lastKey = key

    if (bucket === 0) {
      this.lastLines = [fadeAnsi(this.buildVersionOnly(theme, width), alpha)]
    } else if (bucket === 1) {
      this.lastLines = [fadeAnsi(this.buildCompact(theme, width), alpha)]
    } else {
      this.lastLines = this.buildBox(theme, width, alpha)
    }

    return this.lastLines
  }
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

const THINKING_TOKEN = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax',
} satisfies Record<ThinkingLevel, keyof Theme['colors']>

function styledSep(theme: Theme): string {
  return theme.style(SEP, {
    fg: theme.colors.dim,
  })
}

/**
 * Context bar: a thin heavy line that fills left to right with half-cell
 * precision ("━" full, "╾" half), over a light "─" track. The fill color
 * walks through the logo palette as the context grows (cyan -> yellow ->
 * coral), matching the intro and the input's Tetris line.
 */
const CTX_WARN_AT = 0.6
const CTX_HIGH_AT = 0.85

function contextColorAt(t: number): Color {
  // t = position along the whole bar, 0..1.
  if (t <= CTX_WARN_AT) {
    return mixColors(LOGO_CYAN, LOGO_YELLOW, t / CTX_WARN_AT, 'srgb')
  }

  return mixColors(
    LOGO_YELLOW,
    LOGO_CORAL,
    Math.min(1, (t - CTX_WARN_AT) / (CTX_HIGH_AT - CTX_WARN_AT)),
    'srgb',
  )
}

function renderContextBar(
  theme: Theme,
  usage: ContextUsage | undefined,
  width: number,
): string {
  const window = usage?.contextWindow ?? null
  const tokens = usage?.tokens ?? null
  const pct = usage?.percent ?? null

  const n = Math.max(8, Math.min(22, Math.floor(width / 5)))

  const ratio = pct == null ? 0 : Math.min(1, Math.max(0, pct / 100))

  // Fill in half-cells; any usage at all shows at least half a cell.
  let halves = Math.round(ratio * n * 2)

  if (ratio > 0 && halves === 0) halves = 1

  const full = Math.floor(halves / 2)
  const half = halves % 2

  let bar = ''

  for (let i = 0; i < n; i++) {
    const fg = contextColorAt(n <= 1 ? 0 : i / (n - 1))

    if (i < full) {
      bar += theme.style('━', { fg })
    } else if (i === full && half === 1) {
      // Heavy left half, light right half: the partial cell.
      bar += theme.style('╾', { fg })
    } else {
      bar += theme.style('─', { fg: theme.colors.border })
    }
  }

  const pctColor: Color =
    pct == null
      ? theme.colors.dim
      : ratio < CTX_WARN_AT
        ? LOGO_CYAN
        : ratio < CTX_HIGH_AT
          ? LOGO_YELLOW
          : LOGO_CORAL

  const used = tokens == null ? '?' : fmtTokens(tokens)
  const avail = window == null ? '?' : fmtTokens(window)

  let text = `${used}/${avail}`

  if (pct != null) {
    text += ` ${Math.round(pct)}%`
  }

  return `${bar} ${theme.style(text, { fg: pctColor })}`
}

function buildLine1(
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  width: number,
): string {
  const parts: string[] = [
    theme.style(shortPath(S.ctx?.cwd ?? ''), {
      fg: theme.colors.muted,
    }),
  ]

  const branch = S.branch

  if (branch) {
    parts.push(
      `${theme.style('⎇', {
        fg: theme.colors.dim,
      })} ${theme.style(branch, {
        fg: theme.colors.muted,
      })}`,
    )
  }

  const lsp = footerData.getExtensionStatuses().get('pi-lens-lsp')

  if (lsp) parts.push(lsp)

  // Priority: path > branch > LSP.
  const sep = styledSep(theme)
  let out = parts[0]!

  for (let i = 1; i < parts.length; i++) {
    const candidate = `${out}${sep}${parts[i]}`

    if (visibleWidth(candidate) <= width) {
      out = candidate
    }
  }

  return visibleWidth(out) > width ? truncateMiddle(out, width) : out
}

function buildLine2(theme: Theme, width: number): string {
  const model = S.ctx?.model?.id ?? '—'

  const thinking = (S.ctx?.thinkingLevel ?? 'off') as ThinkingLevel

  const usage = S.lastUsage
  const stats = S.lastTurn

  const modelSeg = `${theme.style('●', {
    fg: theme.colors.accent,
  })} ${theme.style(model, {
    fg: theme.colors.text,
  })}`

  const thinkSeg =
    `${theme.style('think:', {
      fg: theme.colors.dim,
    })} ` +
    `${theme.style(thinking, {
      fg: theme.colors[THINKING_TOKEN[thinking]],
    })}`

  const ctxSeg = renderContextBar(theme, usage, width)

  let tokSeg = ''

  if (stats) {
    if (stats.tokPerSec != null) {
      tokSeg = theme.style(
        `${stats.tokEstimated ? '~' : ''}${fmtRate(stats.tokPerSec)} tok/s`,
        { fg: theme.colors.muted },
      )
    } else if (stats.tokDash) {
      tokSeg = theme.style('—', {
        fg: theme.colors.dim,
      })
    }
  }

  const ttftSeg =
    stats?.ttftMs != null
      ? theme.style(`TTFT ${fmtMs(stats.ttftMs)}`, {
          fg: theme.colors.muted,
        })
      : ''

  // Priority: model > context > thinking > tok/s > TTFT.
  const sep = styledSep(theme)
  let out = modelSeg

  for (const seg of [ctxSeg, thinkSeg, tokSeg, ttftSeg]) {
    if (!seg) continue

    const candidate = `${out}${sep}${seg}`

    if (visibleWidth(candidate) > width) continue

    out = candidate
  }

  return visibleWidth(out) > width ? truncateMiddle(out, width) : out
}

class EmberFooter implements Component {
  private lastKey = ''
  private lastLines: string[] = []

  private unsubBranch: (() => void) | undefined

  constructor(
    tui: TUI,
    private footerData: ReadonlyFooterDataProvider,
  ) {
    S.tui = tui
    S.branch = footerData.getGitBranch()

    this.unsubBranch = footerData.onBranchChange(() => {
      S.branch = footerData.getGitBranch()
      this.lastKey = ''
      tui.requestRender()
    })
  }

  dispose(): void {
    this.unsubBranch?.()
    this.unsubBranch = undefined

    stopPulse()
  }

  invalidate(): void {
    this.lastKey = ''
  }

  render(width: number): string[] {
    const theme = liveTheme()

    if (!S.ctx || !theme) return ['', '']

    const lsp = this.footerData.getExtensionStatuses().get('pi-lens-lsp') ?? ''

    const alpha = revealAlpha(REVEAL_STAGGER_MS)

    const key = [
      alpha,
      width,
      S.branch ?? '',
      lsp,
      S.ctx.model?.id ?? '',
      S.ctx.thinkingLevel ?? '',
      S.lastUsage?.tokens ?? -1,
      S.lastUsage?.contextWindow ?? -1,
      S.lastUsage?.percent ?? -1,
      S.lastTurn?.ttftMs ?? -1,
      S.lastTurn?.tokPerSec ?? -1,
      S.lastTurn?.tokEstimated ? 1 : 0,
      S.lastTurn?.tokDash ? 1 : 0,
    ].join('|')

    if (key === this.lastKey && this.lastLines.length > 0) {
      return this.lastLines
    }

    this.lastKey = key

    this.lastLines = [
      fadeAnsi(buildLine1(theme, this.footerData, width), alpha),
      fadeAnsi(buildLine2(theme, width), alpha),
    ]

    return this.lastLines
  }
}

// ---------------------------------------------------------------------------
// Work state: phase + stopwatch
// ---------------------------------------------------------------------------

function setPhase(phase: Phase, tool?: string): void {
  if (S.phase !== phase || S.toolName !== tool) {
    S.phaseStart = Date.now()
  }

  S.phase = phase
  S.toolName = tool
}

function beginWork(): void {
  const now = Date.now()

  if (S.phase === 'idle' || S.workStart == null) {
    S.workStart = now
  }

  setPhase('prefill')
  startPulse()
}

function finishWork(): void {
  if (S.workStart != null) {
    S.lastDurationMs = Date.now() - S.workStart
  }

  S.workStart = undefined

  setPhase('idle')
  stopPulse()
}

function fmtClock(ms: number): string {
  const s = Math.max(0, ms) / 1000

  if (s < 60) {
    return `${s.toFixed(1)}s`
  }

  return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(
    2,
    '0',
  )}s`
}

// ---------------------------------------------------------------------------
// Activity status text in the top input border
// ---------------------------------------------------------------------------

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function renderStatusText(theme: Theme): string {
  const st = (t: string, fg: Color, bold = false) =>
    theme.style(t, { fg, bold })

  let line = ''

  if (S.phase === 'idle') {
    if (S.lastDurationMs != null) {
      line =
        `${st('✓', theme.colors.success)} ` +
        st(`done in ${fmtClock(S.lastDurationMs)}`, theme.colors.dim)
    }
  } else {
    const now = Date.now()

    const phaseMs = now - S.phaseStart
    const totalMs = now - (S.workStart ?? S.phaseStart)

    const spin = SPINNER[S.pulseTick % SPINNER.length] ?? '⠋'

    const label =
      S.phase === 'prefill'
        ? 'processing prompt'
        : S.phase === 'thinking'
          ? 'thinking'
          : S.phase === 'generating'
            ? 'generating'
            : S.phase === 'toolcall'
              ? 'building tool call'
              : `running ${S.toolName ?? 'tool'}`

    const labelColor =
      S.phase === 'thinking' ? theme.colors.thinkingXhigh : theme.colors.text

    line =
      `${st(spin, theme.colors.accent, true)} ` +
      `${st(label, labelColor)} ` +
      st(fmtClock(phaseMs), theme.colors.accent, true)

    if (totalMs - phaseMs > 1500) {
      line += st(` · total ${fmtClock(totalMs)}`, theme.colors.dim)
    }

    // No live TPS estimate here. Counting streaming update events is not
    // equivalent to counting generated tokens and produced misleading rates.
    // The footer continues showing the completed-turn speed measurement.
  }

  return line
}

// ---------------------------------------------------------------------------
// Bottom border: "Tetris line"
// ---------------------------------------------------------------------------

/**
 * While the agent works, the bottom border of the input plays one Tetris
 * line, echoing the startup intro:
 *
 *   1. Fill   - 4-column pieces in the logo colors (cyan, blue, coral,
 *               yellow) lock in from left to right. The next piece shows as
 *               a faint ghost, the piece that just landed glows briefly.
 *   2. Flash  - the finished line blinks softly (two blinks).
 *   3. Clear  - it vanishes from the center outwards.
 *   4. Rest   - a short pause, then the next line.
 *
 * One tick = PULSE_INTERVAL_MS (100 ms), so a full cycle is ~6 s.
 */
const LINE_CHUNK = 4 // same width as one logo cell
const LINE_FILL_TICKS = 44
const LINE_FLASH_TICKS = 4
const LINE_CLEAR_TICKS = 8
const LINE_REST_TICKS = 4

const LINE_CYCLE_TICKS =
  LINE_FILL_TICKS + LINE_FLASH_TICKS + LINE_CLEAR_TICKS + LINE_REST_TICKS

/**
 * Intensity knobs (0..1). Everything is tinted towards the border color so
 * the line stays calm: raise these for a more vivid animation.
 */
const LINE_TINT = 0.5 // how much of the piece color replaces the border
const LINE_LAND_GLOW = 0.22 // white added to the piece that just landed
const LINE_LAND_GLOW_2 = 0.08 // ...and the one before it
const LINE_FLASH_GLOW = 0.3 // white added while the full line blinks
const LINE_GHOST = 0.22 // visibility of the upcoming piece

const LINE_COLORS: readonly Color[] = [
  LOGO_CYAN,
  LOGO_BLUE,
  LOGO_CORAL,
  LOGO_YELLOW,
]

function renderBottomBorderAnimation(line: string, theme: Theme): string {
  const mode = theme.getColorMode()

  const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')

  const chars = [...plain]

  const horizontalOrder = new Map<number, number>()

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!

    if (ch === '─' || ch === '━' || ch === '═' || ch === '╌' || ch === '┄') {
      horizontalOrder.set(i, horizontalOrder.size)
    }
  }

  const count = horizontalOrder.size

  if (count === 0) {
    return line
  }

  const baseColor = theme.colors.border

  const tick = Math.max(0, S.pulseTick - S.lineStartTick) % LINE_CYCLE_TICKS

  const chunks = Math.ceil(count / LINE_CHUNK)
  const center = (count - 1) / 2

  const inFill = tick < LINE_FILL_TICKS
  const flashEnd = LINE_FILL_TICKS + LINE_FLASH_TICKS
  const clearEnd = flashEnd + LINE_CLEAR_TICKS

  // Pieces locked so far (only meaningful while filling).
  const landed = inFill
    ? Math.min(chunks, Math.floor(((tick + 1) / LINE_FILL_TICKS) * chunks))
    : chunks

  const flashOn =
    tick >= LINE_FILL_TICKS &&
    tick < flashEnd &&
    (tick - LINE_FILL_TICKS) % 2 === 0

  const inClear = tick >= flashEnd && tick < clearEnd

  const clearReach = inClear
    ? ((tick - flashEnd + 1) / LINE_CLEAR_TICKS) * (count / 2)
    : 0

  const resting = tick >= clearEnd

  let output = ''
  let currentKey = ''

  for (let i = 0; i < chars.length; i++) {
    const order = horizontalOrder.get(i)

    let ch = chars[i]!
    let color: Color = baseColor
    let key = 'base'

    if (order !== undefined && !resting) {
      const chunk = Math.floor(order / LINE_CHUNK)
      const pieceColor = LINE_COLORS[chunk % LINE_COLORS.length]!

      const cleared = inClear && Math.abs(order - center) <= clearReach

      if (chunk < landed && !cleared) {
        // Same thin line glyph as the idle border: only the color changes.
        let c: Color = mixColors(baseColor, pieceColor, LINE_TINT, 'srgb')

        if (flashOn) {
          c = mixColors(c, WHITE, LINE_FLASH_GLOW, 'srgb')
        } else if (inFill && chunk === landed - 1) {
          c = mixColors(c, WHITE, LINE_LAND_GLOW, 'srgb')
        } else if (inFill && chunk === landed - 2) {
          c = mixColors(c, WHITE, LINE_LAND_GLOW_2, 'srgb')
        }

        color = c
        key = `p${chunk % LINE_COLORS.length}-${flashOn ? 'f' : ''}${
          inFill ? Math.max(-1, landed - 1 - chunk) : 'x'
        }`
      } else if (inFill && chunk === landed) {
        // Ghost of the piece that is about to lock in.
        color = mixColors(baseColor, pieceColor, LINE_GHOST, 'srgb')
        key = `g${chunk % LINE_COLORS.length}`
      }
    }

    if (key !== currentKey) {
      output += foregroundAnsi(color, mode)
      currentKey = key
    }

    output += ch
  }

  return output + RESET_FG
}

// ---------------------------------------------------------------------------
// Border helpers
// ---------------------------------------------------------------------------

function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
  fill: (text: string) => string = border,
): string {
  if (width <= 0) return ''
  if (width === 1) return border('─')

  let leftText = left
  let rightText = right

  const fixedWidth = 2
  const minimumGap = 3

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap >
      width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(
      rightText,
      Math.max(0, visibleWidth(rightText) - 1),
      '',
    )
  }

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap >
      width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(
      leftText,
      Math.max(0, visibleWidth(leftText) - 1),
      '',
    )
  }

  const gapWidth = Math.max(
    0,
    width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText),
  )

  return (
    `${border('─')}${leftText}` +
    `${fill('─'.repeat(gapWidth))}` +
    `${rightText}${border('─')}`
  )
}

// ---------------------------------------------------------------------------
// Custom editor
// ---------------------------------------------------------------------------

class EmberEditor extends CustomEditor {
  private idleBorder: (s: string) => string

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings, {
      paddingX: 0,
      embedWorkingStatus: false,
    })

    S.tui = tui
    this.idleBorder = theme.borderColor
  }

  render(width: number): string[] {
    const theme = liveTheme()

    // The upper border remains static.
    this.borderColor = this.idleBorder

    const lines = super.render(width)

    if (!theme || lines.length === 0) {
      return lines
    }

    const status = renderStatusText(theme)
    const left = status ? ` ${status} ` : ''

    const border = this.idleBorder

    lines[0] = fitBorder(left, '', width, border)

    // Only the lower border receives the animated gradient.
    if (S.streaming && lines.length > 1) {
      const bottomIndex = lines.length - 1

      lines[bottomIndex] = renderBottomBorderAnimation(
        lines[bottomIndex]!,
        theme,
      )
    }

    const alpha = revealAlpha(REVEAL_STAGGER_MS)

    return alpha < 1 ? lines.map((l) => fadeAnsi(l, alpha)) : lines
  }
}

// ---------------------------------------------------------------------------
// Animation clock (alive only while the agent works)
// ---------------------------------------------------------------------------

function pulseTickFn(): void {
  S.pulseTick += 1
  S.tui?.requestRender()
}

function startPulse(): void {
  S.streaming = true

  if (!S.timer) {
    S.lineStartTick = S.pulseTick

    S.timer = setInterval(pulseTickFn, PULSE_INTERVAL_MS)

    S.timer.unref?.()
  }

  S.tui?.requestRender()
}

function stopPulse(): void {
  S.streaming = false

  if (S.timer) {
    clearInterval(S.timer)
    S.timer = undefined
  }

  S.tui?.requestRender()
}

// ---------------------------------------------------------------------------
// Context usage
// ---------------------------------------------------------------------------

function refreshContextUsage(): void {
  if (!S.ctx) return

  try {
    S.lastUsage = S.ctx.getContextUsage() ?? undefined
  } catch {
    S.lastUsage = undefined
  }
}

// ---------------------------------------------------------------------------
// Per-turn measurements
// ---------------------------------------------------------------------------

function handleAssistantStart(message: AssistantMessage): void {
  S.turn = {
    reqStart: null,
    wallStart: null,
    firstDeltaAt: null,
    lastDeltaAt: null,
    deltaCount: 0,
  }

  const t = S.turn

  t.reqStart = Number.isFinite(message.timestamp) ? message.timestamp : null

  t.wallStart = Date.now()
}

function handleAssistantUpdate(event: MessageUpdateEvent): void {
  const t = S.turn

  if (!t) return

  const type = event.assistantMessageEvent.type

  if (
    type !== 'text_delta' &&
    type !== 'thinking_delta' &&
    type !== 'toolcall_delta'
  ) {
    return
  }

  if (type === 'thinking_delta') {
    setPhase('thinking')
  } else if (type === 'text_delta') {
    setPhase('generating')
  } else {
    setPhase('toolcall')
  }

  const now = Date.now()

  t.deltaCount += 1

  if (t.firstDeltaAt == null) {
    t.firstDeltaAt = now
  }

  t.lastDeltaAt = now
}

function handleAssistantEnd(message: AssistantMessage): void {
  const t = S.turn

  S.turn = undefined

  const stats: TurnStats = {
    ttftMs: null,
    tokPerSec: null,
    tokEstimated: false,
    tokDash: false,
  }

  if (t?.firstDeltaAt != null) {
    const anchor = t.reqStart ?? t.wallStart ?? t.firstDeltaAt

    stats.ttftMs = Math.max(0, t.firstDeltaAt - anchor)

    // Keep the established completed-turn calculation.
    const out = message.usage?.output ?? null

    const tokens = out && out > 0 ? out : t.deltaCount

    stats.tokEstimated = out == null || out <= 0

    const decodeMs =
      t.lastDeltaAt != null ? Math.max(0, t.lastDeltaAt - t.firstDeltaAt) : 0

    if (tokens < 20) {
      stats.tokDash = true
    } else if (decodeMs > 0) {
      stats.tokPerSec = tokens / (decodeMs / 1000)
    } else {
      stats.tokDash = true
    }
  }

  S.lastTurn = stats
  refreshContextUsage()
}

function handleTurnEnd(): void {
  refreshContextUsage()
}

function resetForSession(): void {
  S.branch = null
  S.lastUsage = undefined
  S.lastTurn = undefined
  S.turn = undefined

  S.workStart = undefined
  S.lastDurationMs = undefined

  setPhase('idle')
  stopPulse()
  refreshContextUsage()
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function emberUiExtension(api: ExtensionAPI): void {
  api.on('session_start', async (_event, ctx) => {
    S.ctx = ctx

    applyEmberThemeOnFirstRun(ctx)

    resetForSession()

    try {
      const cmds = api.getCommands()

      S.res = {
        skills: cmds.filter((c) => c.source === 'skill').length,

        prompts: cmds.filter((c) => c.source === 'prompt').length,
      }
    } catch {
      S.res = undefined
    }

    if (ctx.mode !== 'tui' || !ctx.hasUI) {
      return
    }

    /*
     * Temporarily take over the UI for the startup animation.
     *
     * The header, footer, and custom editor are installed only after the
     * centered logo has completed its Tetris animation, held for one second,
     * and moved to the header's logo position.
     */
    let introRan = false

    if (!isAppleTerminalSession()) {
      introRan = true

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new EmberStartupIntro(tui, theme, done),
      )
    }

    // Do not install UI components if this session is no longer active.
    if (S.ctx !== ctx) {
      return
    }

    ctx.ui.setWorkingVisible(false)

    // Start the fade before installing the components so their very first
    // frame is already dark instead of flashing at full brightness.
    if (introRan) startReveal()

    ctx.ui.setHeader((tui, _theme) => new EmberHeader(tui))

    ctx.ui.setFooter(
      (tui, _theme, footerData) => new EmberFooter(tui, footerData),
    )

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new EmberEditor(tui, theme, keybindings),
    )
  })

  api.on('session_shutdown', () => {
    stopPulse()
    stopReveal()

    S.ctx = undefined
    S.tui = undefined
  })

  api.on('agent_start', () => {
    beginWork()
  })

  api.on('agent_end', () => {
    finishWork()
    refreshContextUsage()
  })

  api.on('agent_settled', () => {
    finishWork()
    refreshContextUsage()
  })

  api.on('turn_start', () => {
    S.turn = {
      reqStart: null,
      wallStart: null,
      firstDeltaAt: null,
      lastDeltaAt: null,
      deltaCount: 0,
    }

    beginWork()
  })

  api.on('tool_execution_start', (event) => {
    setPhase('tool', event.toolName)
  })

  api.on('tool_execution_end', () => {
    setPhase('prefill')
  })

  api.on('turn_end', () => {
    handleTurnEnd()
  })

  api.on('message_start', (event) => {
    if (event.message.role === 'assistant') {
      handleAssistantStart(event.message)
    }
  })

  api.on('message_update', (event) => {
    if (event.message.role !== 'assistant') {
      return
    }

    handleAssistantUpdate(event)
  })

  api.on('message_end', (event) => {
    if (event.message.role !== 'assistant') {
      return
    }

    handleAssistantEnd(event.message)
  })

  api.on('session_compact', () => {
    refreshContextUsage()
  })

  api.on('model_select', () => {
    S.tui?.requestRender()
  })

  api.on('thinking_level_select', () => {
    S.tui?.requestRender()
  })
}
