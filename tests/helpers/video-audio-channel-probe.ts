import type { Page } from '@playwright/test'

export interface AudioChannelSamples {
  rms: number
  peak: number
  frequency: number
  firstSamples: number[]
}
export interface VideoAudioChannelObservation {
  graphs: { id: number; state: string; time: number; gains: [number, number];
    input: [AudioChannelSamples, AudioChannelSamples]; output: [AudioChannelSamples, AudioChannelSamples] }[]
  liveProbeNodes: number
  createdGraphs: number
  releasedGraphs: number
  errors: string[]
}
type ChannelProbeWindow = Window & { videoAudioChannels(): VideoAudioChannelObservation }

/** Observe the production splitter -> two gains -> merger -> analyser chain.
 * Measurement branches end at a zero-gain sink; the production edges and gain
 * values are unchanged. Constructors bypass createAnalyser instrumentation in
 * the older video probe, preserving that probe's graph counts and interface. */
export async function installVideoAudioChannelProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect,
      inputs = new WeakMap<AudioNode, { node: AudioNode; output: number }>(),
      mergers = new WeakMap<ChannelMergerNode, Map<number, GainNode>>(),
      owners = new WeakMap<AudioNode, Set<number>>(), errors: string[] = [],
      graphs = new Map<number, { gains: [GainNode, GainNode];
        input: [AnalyserNode, AnalyserNode]; output: [AnalyserNode, AnalyserNode];
        nodes: AudioNode[]; edges: { from: AudioNode; to: AudioNode; output: number }[] }>()
    let next = 1, createdGraphs = 0, releasedGraphs = 0
    const release = (id: number) => {
      const graph = graphs.get(id)
      if (!graph) return
      graphs.delete(id); releasedGraphs++
      for (const edge of graph.edges) {
        try { Reflect.apply(disconnect, edge.from, [edge.to, edge.output, 0]) }
        // The production owner may already have disconnected all its outputs.
        catch (error) { if (!(error instanceof DOMException && error.name === 'InvalidAccessError')) errors.push(String(error)) }
      }
      for (const node of graph.nodes) {
        try { Reflect.apply(disconnect, node, []) } catch (error) { errors.push(String(error)) }
      }
    }
    const observe = (merge: ChannelMergerNode, analyser: AnalyserNode) => {
      if (owners.has(merge)) return
      const pair = mergers.get(merge), left = pair?.get(0), right = pair?.get(1)
      if (!left || !right || pair!.size !== 2) return
      const beforeLeft = inputs.get(left), beforeRight = inputs.get(right)
      if (!beforeLeft || !beforeRight || beforeLeft.node !== beforeRight.node ||
          !(beforeLeft.node instanceof ChannelSplitterNode) || beforeLeft.output !== 0 || beforeRight.output !== 1) return
      const context = merge.context, id = next++, nodes: AudioNode[] = [],
        edges: { from: AudioNode; to: AudioNode; output: number }[] = []
      const own = <T extends AudioNode>(node: T): T => { nodes.push(node); return node }
      try {
        const sink = own(new GainNode(context, { gain: 0 })),
          meter = (source: AudioNode, output: number) => {
            const meter = own(new AnalyserNode(context, { fftSize: 4096,
              smoothingTimeConstant: 0, channelCount: 1, channelCountMode: 'explicit' }))
            Reflect.apply(connect, source, [meter, output, 0]); edges.push({ from: source, to: meter, output })
            Reflect.apply(connect, meter, [sink])
            return meter
          },
          input: [AnalyserNode, AnalyserNode] = [meter(beforeLeft.node, 0), meter(beforeRight.node, 1)],
          output: [AnalyserNode, AnalyserNode] = [meter(left, 0), meter(right, 0)]
        Reflect.apply(connect, sink, [context.destination])
        graphs.set(id, { gains: [left, right], input, output, nodes, edges }); createdGraphs++
        for (const node of [merge, analyser, left, right, beforeLeft.node]) {
          const ids = owners.get(node) ?? new Set<number>(); ids.add(id); owners.set(node, ids)
        }
      } catch (error) {
        errors.push(String(error))
        for (const edge of edges) try { Reflect.apply(disconnect, edge.from, [edge.to, edge.output, 0]) } catch {}
        for (const node of nodes) try { Reflect.apply(disconnect, node, []) } catch {}
      }
    }
    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
      const result = Reflect.apply(connect, this, args), destination = args[0],
        output = typeof args[1] === 'number' ? args[1] : 0, input = typeof args[2] === 'number' ? args[2] : 0
      if (destination instanceof AudioNode) {
        inputs.set(destination, { node: this, output })
        if (destination instanceof ChannelMergerNode && this instanceof GainNode) {
          const gains = mergers.get(destination) ?? new Map<number, GainNode>()
          gains.set(input, this); mergers.set(destination, gains)
        }
        if (this instanceof ChannelMergerNode && destination instanceof AnalyserNode) observe(this, destination)
      }
      return result
    } as AudioNode['connect']
    AudioNode.prototype.disconnect = function (this: AudioNode, ...args: unknown[]) {
      const result = Reflect.apply(disconnect, this, args)
      // Media close disconnects every production node. Watching gains/merger
      // as well as the analyser is independent of init-script wrapper order.
      for (const id of owners.get(this) ?? []) release(id)
      return result
    } as AudioNode['disconnect']
    const samples = (analyser: AnalyserNode): AudioChannelSamples => {
      const wave = new Float32Array(analyser.fftSize), bins = new Float32Array(analyser.frequencyBinCount)
      analyser.getFloatTimeDomainData(wave); analyser.getFloatFrequencyData(bins)
      let squares = 0, peak = 0, largest = -Infinity, frequency = 0
      for (const value of wave) { squares += value * value; peak = Math.max(peak, Math.abs(value)) }
      for (let bin = Math.ceil(100 * analyser.fftSize / analyser.context.sampleRate);
        bin < Math.min(bins.length, 2500 * analyser.fftSize / analyser.context.sampleRate); bin++) {
        if (bins[bin]! > largest) { largest = bins[bin]!; frequency = bin * analyser.context.sampleRate / analyser.fftSize }
      }
      return { rms: Math.sqrt(squares / wave.length), peak, frequency, firstSamples: [...wave.subarray(0, 16)] }
    }
    ;(window as unknown as ChannelProbeWindow).videoAudioChannels = () => ({
      graphs: [...graphs].map(([id, graph]): VideoAudioChannelObservation['graphs'][number] => ({ id, state: graph.gains[0].context.state,
        time: graph.gains[0].context.currentTime, gains: [graph.gains[0].gain.value, graph.gains[1].gain.value],
        input: [samples(graph.input[0]), samples(graph.input[1])],
        output: [samples(graph.output[0]), samples(graph.output[1])] })),
      liveProbeNodes: [...graphs.values()].reduce((sum, graph) => sum + graph.nodes.length, 0),
      createdGraphs, releasedGraphs, errors: [...errors],
    })
  })
}

export const observeVideoAudioChannels = (page: Page): Promise<VideoAudioChannelObservation> =>
  page.evaluate(() => (window as unknown as ChannelProbeWindow).videoAudioChannels())
