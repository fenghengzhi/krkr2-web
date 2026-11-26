import type { DiscChange } from '../engine/ports/cdda.ts'
import type { SessionClient } from '../player/session-client.ts'
import type { LocalGameFile } from '../protocol/session.ts'

export function createLiveDiscControls(parent: HTMLElement) {
  const panel = document.createElement('details')
  panel.id = 'live-disc'
  panel.hidden = true
  panel.innerHTML = `<summary>运行中换盘</summary>
    <label for="live-disc-drive">盘符</label><input id="live-disc-drive" value="D" maxlength="1" spellcheck="false">
    <label for="live-disc-path">光盘路径</label><input id="live-disc-path" placeholder="例如 Disc2.iso 或 CDs.zip&gt;第二张.cue" spellcheck="false">
    <div class="live-disc-actions"><button type="button" id="insert-disc">换入已导入的光盘</button>
    <button type="button" id="choose-live-disc">选择光盘文件</button>
    <button type="button" id="choose-live-disc-folder">选择光盘文件夹</button>
    <input type="file" id="live-disc-files" multiple hidden><input type="file" id="live-disc-folder" webkitdirectory multiple hidden>
    <button type="button" id="eject-disc">弹出</button><button type="button" id="reset-disc">恢复启动时的光盘</button></div>
    <p class="muted">可一起选择 CUE 和轨道文件。轨道分布在子目录时请选择文件夹。换盘只对本次游玩生效。</p>
    <p id="live-disc-status" role="status"></p>`
  parent.append(panel)
  const drive = panel.querySelector<HTMLInputElement>('#live-disc-drive')!,
    path = panel.querySelector<HTMLInputElement>('#live-disc-path')!,
    status = panel.querySelector<HTMLElement>('#live-disc-status')!
  let session: SessionClient | undefined, request = 0
  async function apply(kind: DiscChange['kind'], files?: LocalGameFile[]) {
    const owner = session, current = ++request
    if (!owner) return
    try {
      const letter = drive.value.trim().toUpperCase()
      if (!/^[A-Z]$/.test(letter)) throw new Error('请输入一个盘符，例如 D。')
      let cue = path.value.trim()
      if (files) {
        const media = files.map((file) => file.path).filter((name) => /\.(cue|iso)$/i.test(name))
        const sheets = media.filter((name) => /\.cue$/i.test(name))
        const choices = sheets.length ? sheets : media
        if (!media.includes(cue)) {
          if (choices.length !== 1) throw new Error(choices.length ? '请填写要换入的光盘路径，再次选择这些文件。' : '请选择 ISO 或 CUE 及其轨道文件。')
          cue = choices[0]!
        }
      }
      if (kind === 'insert' && !cue) throw new Error('请填写光盘路径或从设备选择文件。')
      status.textContent = '正在更换 ' + letter + ' 盘…'
      await owner.changeDisc(kind === 'insert' ? { kind, drive: letter, cue } : { kind, drive: letter }, files)
      if (current !== request || owner !== session) return
      if (kind === 'insert') path.value = cue
      status.textContent = letter + (kind === 'insert' ? ' 盘已换入 ' + cue : kind === 'eject' ? ' 盘已弹出。' : ' 盘已恢复启动时的设置。')
    } catch (error) {
      if (current === request && owner === session) status.textContent = error instanceof Error ? error.message : String(error)
    }
  }
  for (const action of ['insert', 'eject', 'reset'] as const)
    panel.querySelector('#' + action + '-disc')!.addEventListener('click', () => { void apply(action) })
  for (const [button, input, folder] of [['#choose-live-disc', '#live-disc-files', false],
    ['#choose-live-disc-folder', '#live-disc-folder', true]] as const) {
    const picker = panel.querySelector<HTMLInputElement>(input)!
    let openedBy: SessionClient | undefined
    panel.querySelector(button)!.addEventListener('click', () => { openedBy = session; picker.click() })
    picker.addEventListener('change', () => {
      const files = Array.from(picker.files ?? [], (blob) => ({
        path: folder ? blob.webkitRelativePath.split('/').slice(1).join('/') : blob.name, blob,
      }))
      picker.value = ''
      if (files.length && (!openedBy || openedBy === session)) void apply('insert', files)
      openedBy = undefined
    })
  }
  return {
    state(next: SessionClient | undefined, enabled: boolean) {
      if (next !== session) {
        session = next; request++; panel.open = false; drive.value = 'D'; path.value = ''; status.textContent = ''
      }
      panel.hidden = !next || !enabled
    },
    place(dialog?: HTMLElement) { (dialog ?? parent).append(panel) },
  }
}
