import { copyCddaDiscs, type CddaDisc } from '../engine/ports/cdda.ts'

/** Human-editable drive bindings; preserve order because an unqualified track uses the first disc. */
export function parseCddaSettings(text: string): readonly CddaDisc[] | undefined {
  if (text.length > 115000) throw new Error('CD 音轨映射过长。')
  if (!text.trim()) return undefined
  if (text.trim() === '无') return copyCddaDiscs([])
  const discs: CddaDisc[] = [], labels = new Map<string, string>()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    const label = /^\s*([a-z])\.label\s*=(.*)$/i.exec(line)
    if (label) {
      const drive = label[1]!.toUpperCase(), value = label[2]!
      if (labels.has(drive)) throw new Error(`CD 音轨映射中的盘符 ${drive} 重复指定卷标。`)
      labels.set(drive, value)
      continue
    }
    const match = /^\s*([a-z])\s*=\s*(.+?)\s*$/i.exec(line)
    if (!match || !match[2]!.trim()) throw new Error(`CD 音轨映射第 ${index + 1} 行应填写 D=disc.cue 这样的盘符和文件路径。`)
    const drive = match[1]!.toUpperCase()
    if (discs.some((disc) => disc.drive === drive)) throw new Error(`CD 音轨映射中的盘符 ${drive} 重复。`)
    discs.push({ drive, cue: match[2]!.trim() })
  }
  for (const drive of labels.keys()) if (!discs.some((disc) => disc.drive === drive))
    throw new Error(`卷标 ${drive}.label 缺少对应的 CUE 路径。`)
  return copyCddaDiscs(discs.map((disc) => ({ ...disc, volumeLabel: labels.get(disc.drive) })))
}

export function formatCddaSettings(discs?: readonly CddaDisc[]): string {
  const copied = copyCddaDiscs(discs)
  return copied === undefined ? '' : copied.length ? copied.map(({ drive, cue, volumeLabel }) =>
    `${drive}=${cue}` + (volumeLabel === undefined ? '' : `\n${drive}.label=${volumeLabel}`)).join('\n') : '无'
}

export function createCddaSettings(labelText: string, id?: string) {
  const element = document.createElement('div'), label = document.createElement('label'),
    input = document.createElement('textarea'), hint = document.createElement('p')
  element.className = 'cdda-settings'
  label.textContent = labelText
  if (id) { input.id = id; label.htmlFor = id }
  else label.append(input)
  input.setAttribute('aria-label', labelText)
  input.rows = 3
  input.maxLength = 115000
  input.spellcheck = false
  input.placeholder = 'D=disc1.cue\nE=disc2.cue'
  hint.className = 'muted'
  hint.textContent = '每行填写盘符和 CUE 路径，路径相对游戏工作目录。游戏按卷标找盘时，可另写一行 D.label=GAME_DISC 指定原盘卷标。留空自动识别唯一一张光盘，填“无”则不绑定光盘。修改在下次启动时生效。'
  element.append(label)
  if (id) element.append(input)
  element.append(hint)
  return { element, input }
}
