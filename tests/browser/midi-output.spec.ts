import { expect, test, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { installWorkerRpcObservation, observeWorkerRpc } from '../helpers/worker-rpc-observation.ts'
import { midiOutputSource } from '../helpers/midi-output.ts'

interface MidiPacket { kind: string; status?: number; data: number[] }
interface MixerPost { at: number; op: string; serial?: number; message?: MidiPacket; posted: boolean }
interface MidiNodeObservation {
  contextState: AudioContextState; disconnects: number; portCloses: number; dropped: number
  posts: MixerPost[]; replyErrors: string[]
}
interface MidiBrowserObservation { available: boolean; nodes: MidiNodeObservation[] }
type MidiObservedWindow = Window & { readMidiOutputObservation(): MidiBrowserObservation }

/** Observe real worklet traffic and device retirement; preserve every native
 * constructor, payload, transfer list, callback and audio render operation. */
async function installMidiObservation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeNode = window.AudioWorkletNode,
      nodes: { node: AudioWorkletNode; record: MidiNodeObservation }[] = []
    ;(window as unknown as MidiObservedWindow).readMidiOutputObservation = () => ({
      available: typeof NativeNode === 'function',
      nodes: nodes.map(({ node, record }) => ({ ...record, contextState: node.context.state,
        posts: record.posts.map((post) => ({ ...post,
          ...(post.message ? { message: { ...post.message, data: [...post.message.data] } } : {}) })),
        replyErrors: [...record.replyErrors] })),
    })
    if (typeof NativeNode !== 'function') return
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options)
        if (name !== 'krkr2-mixer') return
        const record: MidiNodeObservation = { contextState: context.state, disconnects: 0, portCloses: 0,
          dropped: 0, posts: [], replyErrors: [] }, port = this.port, post = port.postMessage,
          close = port.close, disconnect = this.disconnect
        nodes.push({ node: this, record })
        port.postMessage = function (this: MessagePort, value: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
          const request = value as { serial?: number; command?: { op?: string; message?: {
            kind: string; status?: number; data: ArrayLike<number>
          } } }, command = request?.command
          let observation: MixerPost | undefined
          if (command && record.posts.length < 256) {
            observation = { at: performance.now(), op: command.op ?? 'unknown', serial: request.serial, posted: false }
            if (command.op === 'midiMessage' && command.message)
              observation.message = { kind: command.message.kind, data: Array.from(command.message.data),
                ...(command.message.status === undefined ? {} : { status: command.message.status }) }
            record.posts.push(observation)
          } else if (command) record.dropped++
          const result = Reflect.apply(post, this, transfer === undefined ? [value] : [value, transfer])
          if (observation) observation.posted = true
          return result
        } as MessagePort['postMessage']
        port.close = function (this: MessagePort) {
          const result = Reflect.apply(close, this, []); record.portCloses++; return result
        }
        this.disconnect = ((...args: unknown[]) => {
          const result = Reflect.apply(disconnect, this, args); record.disconnects++; return result
        }) as AudioWorkletNode['disconnect']
        port.addEventListener('message', ({ data }: MessageEvent) => {
          if (data?.type === 'reply' && data.error !== undefined) {
            if (record.replyErrors.length < 64) record.replyErrors.push(String(data.error))
            else record.dropped++
          }
        })
      }
    }
  })
}

const observation = (page: Page) => page.evaluate(() => (window as unknown as MidiObservedWindow).readMidiOutputObservation())
const packets = (data: MidiBrowserObservation) => data.nodes.flatMap((node) => node.posts)
  .filter((post) => post.op === 'midiMessage' && post.posted)

const source = midiOutputSource + String.raw`
var midiBrowserExtras=0,midiBrowserMalformed="browser-midi-first";
System.assignMessage("TVPMalformedMIDIMessage",midiBrowserMalformed);
function midiBrowserHolder(value){
  global.midiBrowserMalformed=value;return System.assignMessage("TVPMalformedMIDIMessage",value);
}
function midiBrowserOutput(which){
  try{
    if(which=="basics")return global.midiOutputBasics();
    else if(which=="class")global.MIDISoundBuffer.midiOut(<%90 45 64 46 64%>);
    else if(which=="instance")global.midiOutputBuffer.midiOut(<%80 45 00 46 00%>);
    else if(which=="empty"){
      global.MIDISoundBuffer.midiOut(void);global.midiOutputBuffer.midiOut(<% %>);
      global.MIDISoundBuffer.midiOut(<%ff 01 f7%>);
    }
    else if(which=="missing")global.MIDISoundBuffer.midiOut();
    else if(which=="wrong")global.midiOutputBuffer.midiOut(123);
    else if(which=="malformed")return "error:"+global.midiOutputMalformedRunning();
    else if(which=="partial")return "error:"+global.midiOutputPartial();
    else if(which=="sysex")global.midiOutputBuffer.midiOut(<%f0 7e 7f 09 01 f7%>);
    else if(which=="extra"){
      global.MIDISoundBuffer.midiOut(<%b0 7b 00%>,++global.midiBrowserExtras,"not an octet");
      return "extra="+global.midiBrowserExtras;
    }
    // The shared actual compiled function makes three distinct public calls;
    // browser console round trips cannot consume the pending delay for us.
    else if(which=="delay")return global.midiOutputDelayPair();
    else throw new Exception("Unknown MIDI browser case");
    return "ok";
  }catch(error){
    Debug.message("midi-browser-caught:"+which+":"+error.message);
    if(which=="missing"||which=="wrong")return error.message!=""&&error.message!=global.midiBrowserMalformed?"argument-error":"wrong-argument-error";
    return "error:"+error.message;
  }
}
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: raw MIDI output reaches the worklet, retains its successful prefix and releases on Stop`, async ({ page }, info) => {
    test.setTimeout(120000)
    await installMidiObservation(page)
    await installWorkerRpcObservation(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    test.skip(!(await page.evaluate(() => typeof AudioWorkletNode === 'function')), 'AudioWorklet unavailable')
    const failures: unknown[] = [], errors: string[] = [], stages: unknown[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    const emit = async (which: string, result: string, expected: MidiPacket[]) => {
      const before = packets(await observation(page)).length
      await evaluate(page, `midiBrowserOutput(${JSON.stringify(which)})`, result)
      const after = packets(await observation(page)).slice(before)
      expect(after.map((post) => post.message), which).toEqual(expected)
      stages.push({ which, result, packets: after })
      return after
    }
    const peak = () => page.locator('#sound-level').evaluate((element) => (element as HTMLMeterElement).value)
    const sound = async (phase: string, audible: boolean) => {
      if (audible) await expect.poll(peak).toBeGreaterThan(0.01)
      else await expect.poll(peak).toBe(0)
      stages.push({ phase, audible, workletPeak: await peak() })
    }
    try {
      game = await launchWindowAttention(page, backend, binary, source, [], true)
      await expect(page.locator('#sound-toggle')).toBeEnabled()
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await emit('basics', 'ready', [
        { kind: 'short', status: 0xc0, data: [5] }, { kind: 'short', status: 0xd0, data: [32] },
        { kind: 'short', status: 0xf1, data: [24] }, { kind: 'short', status: 0xf1, data: [25] },
        { kind: 'short', status: 0xf2, data: [1, 2] }, { kind: 'short', status: 0xf3, data: [3] },
        { kind: 'short', status: 0xf6, data: [] }, { kind: 'short', status: 0xf8, data: [] },
        { kind: 'short', status: 0xb0, data: [7, 127] }, { kind: 'short', status: 0xb0, data: [10, 64] },
        { kind: 'short', status: 0xb0, data: [11, 127] },
      ])
      await evaluate(page, 'midiExtraEvaluated', '1')
      await emit('empty', 'ok', [])
      await emit('missing', 'argument-error', [])
      await emit('wrong', 'argument-error', [])
      await emit('class', 'ok', [
        { kind: 'short', status: 0x90, data: [69, 100] }, { kind: 'short', status: 0x90, data: [70, 100] },
      ])
      await sound('class-note-output', true)
      await emit('instance', 'ok', [
        { kind: 'short', status: 0x80, data: [69, 0] }, { kind: 'short', status: 0x80, data: [70, 0] },
      ])
      await sound('instance-note-off', false)
      await emit('malformed', 'error:browser-midi-first', [])
      await evaluate(page, 'midiBrowserHolder("browser-midi-second")', '1')
      await emit('partial', 'error:browser-midi-second', [{ kind: 'short', status: 0x90, data: [69, 100] }])
      // A successful actual note remains audible after a later malformed status.
      await sound('successful-prefix-after-malformed-tail', true)
      await emit('sysex', 'ok', [{ kind: 'long', data: [0xf0, 0x7e, 0x7f, 9, 1, 0xf7] }])
      await sound('original-long-message-GM-reset', false)
      await emit('extra', 'extra=1', [{ kind: 'short', status: 0xb0, data: [123, 0] }])
      const delayed = await emit('delay', 'delivered', [
        { kind: 'short', status: 0xb0, data: [7, 127] }, { kind: 'short', status: 0x90, data: [69, 100] },
      ])
      const intervalMs = delayed[1]!.at - delayed[0]!.at
      expect(intervalMs, 'FF00 retains its 50ms deadline across separate raw output calls').toBeGreaterThanOrEqual(50)
      stages.push({ phase: 'cross-call-delay', intervalMs,
        boundary: 'Passive real worklet post times; minimum delay only, no CPU scheduling upper bound or immediate-return timing claim.' })
      await sound('delayed-output-before-Stop', true)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop()
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
      await expect(page.locator('#sound-toggle')).toBeDisabled()
      await sound('Stop', false)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      const audio = await observation(page), rpc = await observeWorkerRpc(page)
      expect(audio.available).toBe(true)
      expect(audio.nodes).toHaveLength(1)
      for (const node of audio.nodes) {
        expect(node.contextState).toBe('closed')
        expect(node.disconnects).toBeGreaterThan(0)
        expect(node.portCloses).toBeGreaterThan(0)
        expect(node.dropped).toBe(0)
        expect(node.replyErrors).toEqual([])
        expect(node.posts.every((post) => post.posted)).toBe(true)
      }
      expect(rpc.workers).toHaveLength(1)
      expect(rpc.workers[0]!.terminated).toBe(1)
      expect(rpc.workers[0]!.pending).toEqual([])
      expect(rpc.workers[0]!.duplicateReplies).toBe(0)
      expect(rpc.workers[0]!.errors).toEqual([])
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('midi-output-browser', { contentType: 'application/json', body: JSON.stringify({
        backend, binary, stages, pageErrors: errors, audio: await observation(page), rpc: await observeWorkerRpc(page),
        caught: await page.locator('#logs').innerText(),
        scope: 'Real TJS class/instance raw output and audio rendering; passive worklet traffic, dynamic message holders, cross-call minimum host-clock delay and Stop retirement. No OS MIDI device equivalence claim.',
      }, null, 2) })
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI browser output or cleanup failed', { cause: failures[0] })
  })
