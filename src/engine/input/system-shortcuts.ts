import type { DebugPanel } from '../diagnostics/panels.ts'
import { TvpError } from '../system/tvp-error.ts'

const namedKeys: Readonly<Record<string, number>> = {
  bksp: 8, backspace: 8, tab: 9, enter: 13, esc: 27, escape: 27, space: 32,
  shift: 16, ctrl: 17, alt: 18, pause: 19, capslock: 20,
  pgup: 33, pageup: 33, 'page up': 33, pgdn: 34, pagedown: 34, 'page down': 34,
  end: 35, home: 36, left: 37, up: 38, right: 39, down: 40,
  ins: 45, insert: 45, del: 46, delete: 46,
  'num *': 106, 'num +': 107, 'num -': 109, 'num del': 110, 'num .': 110, 'num /': 111,
  numlock: 144, 'num lock': 144, scrolllock: 145, 'scroll lock': 145,
  ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188, '-': 189, '_': 189,
  '.': 190, '>': 190, '/': 191, '?': 191, '`': 192, '~': 192,
  '[': 219, '{': 219, '\\': 220, '|': 220, ']': 221, '}': 221, "'": 222, '"': 222,
}
type Shortcut = { panel: DebugPanel; key: number; shift: number }

/** WindowForm's built-in popup commands are independent of script MenuItems.
 * MainForm freezes their configured keys at startup; empty options disable them. */
export class WindowSystemShortcuts {
  private readonly shortcuts: Shortcut[] = []
  private showable?: boolean
  constructor(private readonly arguments_: ReadonlyMap<string, string>, warn: (message: string) => void = () => {}) {
    for (const [panel, fallback] of [['controller', 'Shift+F1'], ['console', 'Shift+F4']] as const) {
      const option = '-hk' + panel, value = arguments_.get(option) ?? fallback
      if (!value) continue
      let name = value.toLowerCase(), shift = 0, modifier: RegExpExecArray | null
      while ((modifier = /^(shift|ctrl|alt)\+/.exec(name))) {
        shift |= modifier[1] === 'shift' ? 1 : modifier[1] === 'alt' ? 2 : 4
        name = name.slice(modifier[0].length)
      }
      if (!name || name.startsWith('+') && name !== '+')
        throw new TvpError('TVPInvalidCommandLineParam', [option, value], `Invalid ${option} shortcut`)
      const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(name), numpad = /^num ([0-9])$/.exec(name),
        key = (Object.hasOwn(namedKeys, name) ? namedKeys[name] : undefined) ?? (functionKey ? 111 + Number(functionKey[1]) : numpad ? 96 + Number(numpad[1])
          : /^[a-z0-9]$/.test(name) ? name.toUpperCase().charCodeAt(0) : undefined)
      // VCL obtains additional names from the Windows keyboard locale. The
      // Web key codes above follow BrowserInput's existing Win32 mapping;
      // an unknown localized name must not prevent the game from starting.
      if (key === undefined) { warn(`Unsupported system shortcut ${option}=${value}; command key disabled`); continue }
      this.shortcuts.push({ panel, key, shift })
    }
  }
  match(key: number, shift: number): DebugPanel | undefined {
    return this.shortcuts.find((item) => item.key === key && item.shift === (shift & 7))?.panel
  }
  keys(): { key: number; shift: number }[] { return this.shortcuts.map(({ key, shift }) => ({ key, shift })) }
  /** Stock MainForm checks -debugwin once, when a support window is requested. */
  canShow(): boolean { return this.showable ??= this.arguments_.get('-debugwin') !== 'no' }
}
