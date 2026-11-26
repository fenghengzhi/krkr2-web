import { copyCddaDiscs, type CddaDisc } from '../engine/ports/cdda.ts'
import { scriptEncodings, type ScriptEncoding } from '../engine/script/text-encoding.ts'

export const textEncodingLabels: Record<ScriptEncoding, string> = {
  auto: '自动（先 UTF-8，再尝试日文）', shift_jis: '日文（Shift_JIS）', gbk: '简体中文（GBK）',
  big5: '繁体中文（Big5）', 'euc-kr': '韩文（Windows-949）', 'windows-1251': '西里尔字母（Windows-1251）',
  'windows-1252': '西欧（Windows-1252）', 'utf-8': 'UTF-8',
}

/** Human-editable drive bindings; preserve order because an unqualified track uses the first disc. */
export function parseCddaSettings(text: string): readonly CddaDisc[] | undefined {
  if (text.length > 115000) throw new Error('游戏光盘映射过长。')
  if (!text.trim()) return undefined
  if (text.trim() === '无') return copyCddaDiscs([])
  const discs: CddaDisc[] = [], labels = new Map<string, string>()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    const label = /^\s*([a-z])\.label\s*=(.*)$/i.exec(line)
    if (label) {
      const drive = label[1]!.toUpperCase(), value = label[2]!
      if (labels.has(drive)) throw new Error(`游戏光盘映射中的盘符 ${drive} 重复指定卷标。`)
      labels.set(drive, value)
      continue
    }
    const match = /^\s*([a-z])\s*=\s*(.+?)\s*$/i.exec(line)
    if (!match || !match[2]!.trim()) throw new Error(`游戏光盘映射第 ${index + 1} 行应填写 D=disc.cue 这样的盘符和文件路径。`)
    const drive = match[1]!.toUpperCase()
    if (discs.some((disc) => disc.drive === drive)) throw new Error(`游戏光盘映射中的盘符 ${drive} 重复。`)
    discs.push({ drive, cue: match[2]!.trim() })
  }
  for (const drive of labels.keys()) if (!discs.some((disc) => disc.drive === drive))
    throw new Error(`卷标 ${drive}.label 缺少对应的光盘路径。`)
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
  input.placeholder = 'D=music.cue\nE=story.iso'
  hint.className = 'muted'
  hint.textContent = '每行填写盘符和光盘路径，例如 D=music.cue 或 E=story.iso。路径可以相对游戏工作目录。光盘与游戏 ZIP 分开发行时，请一起导入，可填写 E=Extras/story.iso 或 G=Voices.zip>Media/story.cue。可另写一行 D.label=GAME_DISC 指定卷标。留空优先识别唯一的 CUE，没有 CUE 时识别唯一的 ISO。填“无”则不绑定光盘。此处的映射在下次启动时生效。'
  element.append(label)
  if (id) element.append(input)
  element.append(hint)
  const encodingLabel = document.createElement('label'), encoding = document.createElement('select')
  encodingLabel.textContent = '无 BOM 的 CUE 文件编码'
  for (const name of scriptEncodings) encoding.add(new Option(textEncodingLabels[name], name))
  if (id) encoding.id = 'cue-encoding'
  encodingLabel.append(encoding)
  element.append(encodingLabel)
  return { element, input, encoding }
}
