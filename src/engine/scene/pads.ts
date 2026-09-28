import type {
  PadAck,
  PadMessage,
  PadPresentation,
  PadSaveRequest,
  PadView,
} from '../../protocol/pad.ts'
import type {
  ScriptRuntime,
  ScriptObject,
  ScriptWeakObject,
  ScriptValue,
} from '../script/runtime.ts'
import type { SystemColors } from '../graphics/system-colors.ts'
import type { ModalLoop } from '../scheduler/modal-loop.ts'

export const padProperties = [
  'text',
  'fileName',
  'color',
  'visible',
  'title',
  'fontColor',
  'fontHeight',
  'fontSize',
  'fontBold',
  'fontItalic',
  'fontUnderline',
  'fontStrikeOut',
  'fontFace',
  'readOnly',
  'wordWrap',
  'opacity',
  'showStatusBar',
  'showScrollBars',
  'statusText',
  'borderStyle',
  'width',
  'height',
  'top',
  'left',
] as const
export type PadProperty = (typeof padProperties)[number]
export interface PadPolicy {
  maxPads: number
  maxText: number
  maxTotalText: number
  /** The fixed reference SDK uses fixed-255. Alternate source builds may opt into alpha blending. */
  opacity: 'alpha-blend' | 'fixed-255'
}
export const defaultPadPolicy: Readonly<PadPolicy> = Object.freeze({
  maxPads: 32,
  maxText: 10_000_000,
  maxTotalText: 16_777_216,
  opacity: 'fixed-255',
})
interface PadRecord {
  view: PadView
  sequence: number
  owner: ScriptWeakObject
}
interface SaveRecord {
  request: PadSaveRequest
  token?: number
  ready: boolean
}
/** Web retains Unicode, while the source's NUL boundary is preserved. RichEdit
 * round-trip choices are isolated here for calibration against hosted SDK evidence. */
export function padText(text: string): string {
  return text.split('\0', 1)[0].replace(/(?<!\r)\n/g, '\r\n')
}
export function padDownloadName(value: string): string {
  const base = value
    .split(/[\\/]/)
    .at(-1)!
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .trim()
  const name = base && base !== '.' && base !== '..' ? base : 'pad.tjs'
  return /\.[^.]+$/.test(name) ? name : name + '.tjs'
}
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

/** Pad owns pure values only. TJS native lifetime owns destruction, including
 * finalizer retry; the service never holds an owning reference to the instance. */
export class PadService {
  private readonly records = new Map<number, PadRecord>()
  private nextId = 1
  private nextSave = 1
  private nextReceipt = 1
  private save?: SaveRecord
  private ended = false
  private published = ''
  constructor(
    private readonly runtime: ScriptRuntime,
    private readonly colors: SystemColors,
    private readonly loop: ModalLoop,
    private readonly actions: {
      changed(value: PadPresentation): void
      blocked(): boolean
      covered?(): boolean
      enter?(): void
    },
    private readonly policy: Readonly<PadPolicy> = defaultPadPolicy,
  ) {
    for (const key of ['maxPads', 'maxText', 'maxTotalText'] as const)
      if (!integer(policy[key]) || policy[key] < 1) throw new Error('Invalid Pad resource budget')
  }
  get count(): number {
    return this.records.size
  }
  get textUnits(): number {
    let size = 0
    for (const record of this.records.values()) size += record.view.text.length
    return size
  }
  construct(owner: ScriptObject): number {
    if (this.ended || this.records.size >= this.policy.maxPads)
      throw new Error('Pad instance budget exceeded')
    if (this.runtime.nativeLifetimeIdentifier(owner, 'Pad.nativeInvalidate') !== undefined)
      throw new Error('Pad has already been constructed')
    if (!Number.isSafeInteger(this.nextId)) throw new Error('Pad identifiers exhausted')
    const id = this.nextId++,
      offset = ((id - 1) % 12) * 20
    const view: PadView = {
      id,
      epoch: 1,
      textEpoch: 1,
      revision: 1,
      acceptedEditSeq: 0,
      text: '',
      fileName: '',
      color: 0x000080,
      visible: false,
      title: 'Pad',
      inkColor: 0xffffff,
      fontHeight: 12,
      fontSize: 9,
      fontBold: false,
      fontItalic: false,
      fontUnderline: false,
      fontStrikeOut: false,
      fontFace: 'ＭＳ 明朝',
      readOnly: false,
      wordWrap: false,
      opacity: 255,
      showStatusBar: true,
      showScrollBars: 3,
      statusText: '',
      borderStyle: 2,
      width: 538,
      height: 352,
      top: offset,
      left: offset,
      blocked: false,
    }
    const weak = this.runtime.observe(owner, () => this.remove(id))
    try {
      this.runtime.registerNativeLifetime(owner, 'Pad.nativeInvalidate', id)
      this.records.set(id, { view, sequence: 0, owner: weak })
      this.present()
    } catch (error) {
      this.records.delete(id)
      this.runtime.unobserve(weak)
      throw error
    }
    return id
  }
  private record(id: number): PadRecord {
    const record = this.records.get(id)
    if (!record || this.ended) throw new Error('Pad has been invalidated')
    return record
  }
  private property(name: string): PadProperty {
    if (!(padProperties as readonly string[]).includes(name))
      throw new Error('Unknown Pad property')
    return name as PadProperty
  }
  get(id: number, name: string): ScriptValue {
    const view = this.record(id).view,
      property = this.property(name)
    if (property === 'fontColor') return BigInt(view.color)
    const value = view[property]
    return typeof value === 'boolean'
      ? value
        ? 1n
        : 0n
      : typeof value === 'number'
        ? BigInt(value)
        : value
  }
  set(id: number, name: string, value: ScriptValue): void {
    const record = this.record(id),
      property = this.property(name),
      current = record.view
    const view = { ...current }
    if (['text', 'fileName', 'title', 'statusText', 'fontFace'].includes(property)) {
      if (typeof value !== 'string') throw new Error('Pad property requires native text')
      if (property === 'text') {
        if (value.length > this.policy.maxText) throw new Error('Pad text budget exceeded')
        const text = padText(value)
        this.checkText(text, current.text.length)
        view.text = text
        view.textEpoch++
      } else {
        if (value.length > 8192) throw new Error('Pad label exceeds budget')
        ;(view as unknown as Record<string, unknown>)[property] = value.split('\0', 1)[0]
      }
    } else {
      if (typeof value !== 'bigint' && typeof value !== 'number')
        throw new Error('Pad property requires a native number')
      const number = Number(value)
      if (!integer(number)) throw new Error('Pad property requires an integer')
      switch (property) {
        case 'color':
          view.color = this.colors.toActualColor(number)
          break
        case 'fontColor':
          view.inkColor = this.colors.toActualColor(number)
          break
        case 'visible':
          view.visible = !!number
          if (view.visible !== current.visible) {
            view.epoch++
            record.sequence = 0
            view.acceptedEditSeq = 0
          }
          break
        case 'fontHeight':
          view.fontHeight = Math.abs(number)
          view.fontSize = Math.round((view.fontHeight * 72) / 96)
          break
        case 'fontSize':
          view.fontSize = Math.abs(number)
          view.fontHeight = Math.round((view.fontSize * 96) / 72)
          break
        case 'opacity':
          view.opacity =
            this.policy.opacity === 'fixed-255' ? 255 : Math.max(0, Math.min(255, number))
          break
        case 'showScrollBars':
          if (number < 0 || number > 3) throw new Error('Unsupported Pad scrollbar style')
          view.showScrollBars = number
          break
        case 'borderStyle':
          if (number < 0 || number > 5) throw new Error('Unsupported Pad border style')
          view.borderStyle = number
          break
        case 'width':
          view.width = number
          break
        case 'height':
          view.height = number
          break
        case 'top':
          view.top = number
          break
        case 'left':
          view.left = number
          break
        default:
          ;(view as unknown as Record<string, unknown>)[property] = !!number
      }
    }
    view.revision++
    record.view = view
    if (!view.visible && this.save?.request.padId === id) this.abortSave()
    this.present()
  }
  private checkText(text: string, previous: number): void {
    if (
      text.length > this.policy.maxText ||
      this.textUnits - previous + text.length > this.policy.maxTotalText
    )
      throw new Error('Pad text budget exceeded')
  }
  remove(id: number): void {
    const record = this.records.get(id)
    if (!record) return
    if (this.save?.request.padId === id) this.abortSave()
    this.records.delete(id)
    this.runtime.unobserve(record.owner)
    this.present()
  }
  private view(record: PadRecord): PadView {
    return { ...record.view, blocked: this.actions.blocked() }
  }
  presentation(): PadPresentation {
    const save = this.save,
      top = this.loop.activeToken,
      info = top === undefined ? undefined : this.loop.info(top)
    const token =
      save?.token ??
      (info?.kind === 'pad-save' && info.ownerId === save?.request.id ? top : undefined)
    const active = token !== undefined && token === top
    return {
      pendingSaveId: save?.request.id ?? null,
      pads: [...this.records.values()].map((record) => this.view(record)),
      save:
        save && active && !save.ready && !this.actions.covered?.() && this.loop.isPending(token!)
          ? { ...save.request }
          : null,
    }
  }
  present(): void {
    // Outcome acknowledgements can arrive while a later child dialog owns the
    // top. Keep that child's frame intact; finish the host parent only after
    // its child really releases. This also works while the VM is paused.
    const save = this.save
    if (
      save?.ready &&
      save.token !== undefined &&
      save.token === this.loop.activeToken &&
      this.loop.isPending(save.token)
    )
      this.loop.finishHost(save.token)
    const value = this.presentation()
    const signature = JSON.stringify([
      value.pendingSaveId,
      value.pads.map((p) => [p.id, p.revision, p.epoch, p.blocked]),
      value.save && [value.save.id, value.save.receipt, value.save.error],
    ])
    if (signature === this.published) return
    this.published = signature
    this.actions.changed(value)
  }
  admit(message: PadMessage): PadAck {
    if (
      !message ||
      !integer(message.id) ||
      !integer(message.epoch) ||
      !integer(message.seq) ||
      message.seq <= 0 ||
      !integer(message.baseTextEpoch)
    )
      throw new Error('Invalid Pad message identity')
    const record = this.records.get(message.id)
    const ignored = (): PadAck => ({
      status: 'ignored',
      ...(record ? { view: this.view(record) } : {}),
    })
    if (
      this.ended ||
      !record ||
      !record.view.visible ||
      record.view.epoch !== message.epoch ||
      message.seq <= record.sequence
    )
      return ignored()
    const saveMessage = ['save-confirm', 'save-cancel', 'save-outcome'].includes(message.kind)
    if (!saveMessage && (this.actions.blocked() || message.baseTextEpoch !== record.view.textEpoch))
      return ignored()
    if (saveMessage) {
      const save = this.save,
        outcome = message.kind === 'save-outcome' || message.kind === 'save-cancel'
      if (
        (!outcome && this.actions.covered?.()) ||
        !save ||
        !('requestId' in message) ||
        message.requestId !== save.request.id ||
        message.id !== save.request.padId ||
        message.epoch !== save.request.epoch ||
        save.token === undefined ||
        !this.loop.isPending(save.token) ||
        (!outcome && save.token !== this.loop.activeToken) ||
        save.ready
      )
        return ignored()
    }
    switch (message.kind) {
      case 'edit': {
        if (record.view.readOnly) return ignored()
        if (typeof message.text !== 'string') throw new Error('Invalid Pad edit')
        if (message.text.length > this.policy.maxText) throw new Error('Pad text budget exceeded')
        const text = padText(message.text)
        this.checkText(text, record.view.text.length)
        record.view = {
          ...record.view,
          text,
          acceptedEditSeq: message.seq,
          revision: record.view.revision + 1,
        }
        break
      }
      case 'selection': {
        const length = record.view.text.replace(/\r\n|\r/g, '\n').length
        if (
          !integer(message.start) ||
          !integer(message.end) ||
          message.start < 0 ||
          message.end < message.start ||
          message.end > length
        )
          throw new Error('Invalid Pad selection')
        break
      }
      case 'geometry':
        if (!['move', 'resize', 'restore'].includes(message.mode))
          throw new Error('Invalid Pad geometry operation')
        if (
          ![message.left, message.top, message.width, message.height].every(
            (value) => integer(value) && value >= -2147483648 && value <= 2147483647,
          )
        )
          throw new Error('Invalid Pad geometry')
        record.view = {
          ...record.view,
          left: message.left,
          top: message.top,
          width:
            message.mode === 'move'
              ? record.view.width
              : message.mode === 'resize'
                ? Math.max(70, message.width)
                : message.width,
          height:
            message.mode === 'move'
              ? record.view.height
              : message.mode === 'resize'
                ? Math.max(100, message.height)
                : message.height,
          revision: record.view.revision + 1,
        }
        break
      case 'close':
        this.set(message.id, 'visible', 0n)
        return { status: 'accepted', view: this.view(record) }
      case 'save-open':
        if (this.save) return ignored()
        this.save = {
          request: {
            id: this.nextSave++,
            padId: message.id,
            epoch: message.epoch,
            revision: record.view.revision,
            fileName: padDownloadName(record.view.fileName),
            text: record.view.text,
          },
          ready: false,
        }
        record.sequence = message.seq
        this.enterSave(this.save)
        break
      case 'save-confirm': {
        if (
          typeof message.fileName !== 'string' ||
          message.fileName.length > 8192 ||
          this.save!.request.receipt !== undefined
        )
          return ignored()
        this.save!.request = {
          ...this.save!.request,
          fileName: padDownloadName(message.fileName),
          receipt: this.nextReceipt++,
          error: undefined,
        }
        break
      }
      case 'save-cancel':
        this.save!.ready = true
        break
      case 'save-outcome':
        if (
          !integer(message.receipt) ||
          this.save!.request.receipt !== message.receipt ||
          typeof message.ok !== 'boolean' ||
          (message.error !== undefined &&
            (typeof message.error !== 'string' || message.error.length > 8192))
        )
          return ignored()
        if (message.ok) {
          record.view = {
            ...record.view,
            fileName: this.save!.request.fileName,
            revision: record.view.revision + 1,
          }
          this.save!.ready = true
        } else
          this.save!.request = {
            ...this.save!.request,
            receipt: undefined,
            error: message.error || 'Browser download failed',
          }
        break
      default:
        throw new Error('Unknown Pad message operation')
    }
    record.sequence = message.seq
    this.present()
    return { status: 'accepted', view: this.view(record) }
  }
  fontRequest(
    id: number,
    epoch: number,
  ): Pick<PadView, 'fontFace' | 'fontBold' | 'fontItalic'> | undefined {
    const record = this.records.get(id)
    if (this.ended || !record || record.view.epoch !== epoch || !record.view.visible)
      return undefined
    const { fontFace, fontBold, fontItalic } = record.view
    return { fontFace, fontBold, fontItalic }
  }
  private enterSave(save: SaveRecord): void {
    try {
      save.token = this.loop.openHost({
        kind: 'pad-save',
        ownerId: save.request.id,
        cleanup: () => {
          if (this.save === save) this.save = undefined
        },
      })
      this.actions.enter?.()
      this.present()
    } catch (error) {
      this.abortSave()
      throw error
    }
  }
  private abortSave(): void {
    const save = this.save
    if (!save) return
    save.ready = true
    if (save.token !== undefined) this.loop.cancel(save.token, 'Pad save retired')
    else this.save = undefined
    this.loop.notify()
  }
  dispose(): void {
    if (this.ended) return
    this.ended = true
    this.abortSave()
    for (const record of this.records.values()) this.runtime.unobserve(record.owner)
    this.records.clear()
    this.save = undefined
    this.present()
  }
}
