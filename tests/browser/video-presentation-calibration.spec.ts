import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Video presentation calibration requires GitHub-hosted Actions')

interface ReferenceFrame {
  index: number
  presentationTime: number
  png: string
  bytes: number
  sha256: string
  frame: Record<string, unknown>
}
interface ReferenceFixture {
  file: string
  sha256: string
  bytes: number
  width: number
  height: number
  numbered: boolean
  format: { duration: string }
  frames: ReferenceFrame[]
}
interface ReferenceManifest {
  schema: number
  commit: string
  runId: string
  numberedInput: unknown
  fixtures: ReferenceFixture[]
}

const names = ['multitrack', 'fragmented', 'interleaved', 'separate-fragments',
  'numbered-multitrack', 'numbered-fragmented', 'numbered-interleaved', 'numbered-separate-fragments',
  'numbered-variable'] as const,
  directory = resolve('out/verification/video-tracks'), hash = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex')

for (const name of names) test(`observe independent video clock, callback and complete pixels: ${name}`, async ({ page }, info) => {
  test.setTimeout(90000)
  const manifestBytes = readFileSync(resolve(directory, 'presentation-reference.json')),
    manifest = JSON.parse(manifestBytes.toString('utf8')) as ReferenceManifest,
    reference = manifest.fixtures.find((fixture) => fixture.file === name + '.mp4')
  expect(manifest.schema).toBe(1)
  expect(manifest.commit).toBe(process.env.GITHUB_SHA)
  expect(manifest.fixtures.map((fixture) => fixture.file).sort()).toEqual(names.map((name) => name + '.mp4').sort())
  expect(reference).toBeDefined()
  const fixture = reference!, bytes = readFileSync(resolve(directory, fixture.file))
  expect(hash(bytes)).toBe(fixture.sha256)
  expect(bytes.length).toBe(fixture.bytes)
  expect(fixture.frames).toHaveLength(72)
  const frames = fixture.frames.map((frame, index) => {
    expect(frame.index).toBe(index)
    expect(Number.isFinite(frame.presentationTime)).toBe(true)
    const path = resolve(directory, frame.png)
    expect(path.startsWith(directory + sep)).toBe(true)
    const png = readFileSync(path), decoded = readScreenshotPng(png)
    expect(png.length).toBe(frame.bytes)
    expect(hash(png)).toBe(frame.sha256)
    expect([decoded.width, decoded.height]).toEqual([fixture.width, fixture.height])
    return { ...frame, rgba: decoded.rgba }
  }), duration = Number(fixture.format.duration), last = frames.at(-1)!.presentationTime,
    requests = [
      { name: 'zero', time: 0 },
      { name: 'indexed-midpoint', time: (frames[15]!.presentationTime + frames[16]!.presentationTime) / 2 },
      { name: 'archived-non-PTS-request', time: 1.322687 },
      { name: 'two-seconds', time: 2 },
      { name: 'tail-midpoint', time: (last + duration) / 2 },
    ], pageErrors: string[] = []
  if (fixture.numbered) expect(new Set(frames.map((frame) => hash(frame.rgba))).size).toBe(72)
  expect(Number.isFinite(duration) && duration > last).toBe(true)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/presentation-calibration.html', (route) => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>Independent video presentation calibration</title><body></body>' }))
  await page.route('**/presentation-calibration.mp4', (route) => route.fulfill({ contentType: 'video/mp4', body: bytes }))
  await page.goto('/presentation-calibration.html')
  const result = await page.evaluate(async ({ requests, width, height }) => {
    const blob = await (await fetch('/presentation-calibration.mp4')).blob(), url = URL.createObjectURL(blob),
      events: Record<string, unknown>[] = [], captures: { phase: string; stage: string; videoId: number;
        currentTime: number; seeking: boolean; readyState: number; at: number;
        metadata: Record<string, number | null> | null; pixels: number[]; error: string | null }[] = [],
      steps: { phase: string; stage: string; videoId: number; requestedTime: number;
        previousTime: number; seeked: boolean; freshCallback: boolean; status: string }[] = [],
      failures: string[] = [], live = new Set<HTMLVideoElement>()
    let nextId = 1, droppedEvents = 0, opened = 0, retired = 0
    const open = async (phase: string) => {
      const video = document.createElement('video'), videoId = nextId++, abort = new AbortController(),
        canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      video.muted = true; video.playsInline = true; video.preload = 'auto'
      video.style.cssText = 'display:block;width:256px;height:192px'
      document.body.append(video); live.add(video)
      let latest: Record<string, number | null> | null = null, frameRequest: number | undefined
      const state = () => ({ videoId, currentTime: video.currentTime, duration: video.duration,
        seeking: video.seeking, readyState: video.readyState, paused: video.paused,
        ended: video.ended, metadata: latest }),
        record = (event: string) => {
          if (events.length >= 1024) { droppedEvents++; return }
          events.push({ phase, event, at: performance.now(), ...state() })
        }, capture = (stage: string) => {
          let pixels: number[] = [], error: string | null = null
          try {
            if (video.readyState < 2 || video.videoWidth !== width || video.videoHeight !== height)
              throw new Error('Decoded video dimensions/readiness unavailable')
            context.drawImage(video, 0, 0)
            pixels = [...context.getImageData(0, 0, width, height).data]
          } catch (failure) { error = String(failure) }
          captures.push({ phase, stage, videoId, currentTime: video.currentTime,
            seeking: video.seeking, readyState: video.readyState, at: performance.now(), metadata: latest, pixels, error })
        }, requestFrame = (stage: string, arrived: () => void) => {
          frameRequest = video.requestVideoFrameCallback((_now, metadata) => {
            frameRequest = undefined
            latest = { mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
              presentationTime: metadata.presentationTime, expectedDisplayTime: metadata.expectedDisplayTime,
              width: metadata.width, height: metadata.height, processingDuration: metadata.processingDuration ?? null }
            record('requestVideoFrameCallback')
            // 098 Chromium observations deliver the compositor callback while
            // readyState is still HAVE_METADATA. Preserve that event, then
            // capture full pixels once the separate decoded-data gate opens.
            if (video.readyState >= 2) capture(stage + '/callback')
            else record('callback-pixels-await-loadeddata')
            arrived()
          })
        }, cancelFrame = () => {
          if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest)
          frameRequest = undefined
        }
      for (const event of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'seeking', 'seeked', 'pause', 'playing', 'error', 'emptied'])
        video.addEventListener(event, () => record(event), { signal: abort.signal })
      const close = () => {
        cancelFrame(); abort.abort(); video.pause(); video.removeAttribute('src'); video.load(); video.remove()
        canvas.width = canvas.height = 0
        if (live.delete(video)) retired++
      }
      const ready = await new Promise<boolean>((resolve) => {
        let ended = false, presented = false
        const finish = (value: boolean) => {
          if (ended) return
          ended = true; clearTimeout(timer); video.removeEventListener('error', failed)
          video.removeEventListener('loadeddata', complete); video.removeEventListener('canplay', complete)
          cancelFrame(); resolve(value)
        }, complete = () => { if (presented && video.readyState >= 2) finish(true) },
          failed = () => finish(false), timer = setTimeout(() => finish(false), 5000)
        video.addEventListener('error', failed, { once: true })
        video.addEventListener('loadeddata', complete); video.addEventListener('canplay', complete)
        try {
          requestFrame('initial', () => { presented = true; complete() })
          video.src = url; video.load()
        } catch (error) { failures.push(String(error)); finish(false) }
      })
      capture(ready ? 'initial/settled' : 'initial/timed-out')
      if (!ready) { failures.push(`Video ${videoId} did not produce an initial frame`); close(); return }
      opened++
      return { video, videoId, close, async seek(request: { name: string; time: number }) {
        const previousTime = video.currentTime, sameTime = Math.abs(previousTime - request.time) <= 1e-8
        let sought = false, presented = false
        const status = await new Promise<string>((resolve) => {
          let ended = false, sameTimeFrame: number | undefined
          const finish = (value: string) => {
            if (ended) return
            ended = true; clearTimeout(timer); cancelFrame()
            if (sameTimeFrame !== undefined) cancelAnimationFrame(sameTimeFrame)
            video.removeEventListener('seeked', seeked); video.removeEventListener('loadeddata', complete)
            video.removeEventListener('error', failed); resolve(value)
          }, complete = () => {
            if (video.seeking || video.readyState < 2) return
            if (sought && presented) finish('seeked-and-presented')
            else if (sameTime && latest && sameTimeFrame === undefined)
              sameTimeFrame = requestAnimationFrame(() => {
                sameTimeFrame = undefined
                if (!video.seeking && video.readyState >= 2)
                  finish(presented ? 'same-time-presented' : 'same-time-existing-frame')
              })
          }, seeked = () => { sought = true; complete() }, failed = () => finish('media-error'),
            timer = setTimeout(() => finish('timed-out'), 4000)
          video.addEventListener('seeked', seeked); video.addEventListener('error', failed, { once: true })
          video.addEventListener('loadeddata', complete)
          try {
            requestFrame(request.name, () => { presented = true; complete() })
            record('seek-request:' + request.time); video.currentTime = request.time; complete()
          } catch (error) { failures.push(String(error)); finish('exception') }
        })
        steps.push({ phase, stage: request.name, videoId, requestedTime: request.time,
          previousTime, seeked: sought, freshCallback: presented, status })
        capture(request.name + '/' + status)
      } }
    }
    try {
      const sequential = await open('sequential')
      if (sequential) {
        try { for (const request of requests) await sequential.seek(request) }
        finally { sequential.close() }
      }
      // This is a fresh paused decoder of the same encoded container. It does
      // not exercise the rewritten MP4 variant produced by track replacement
      // or claim that the product's audio-switch transaction is correct.
      for (const request of requests) {
        const fresh = await open('fresh/' + request.name)
        if (fresh) { try { await fresh.seek(request) } finally { fresh.close() } }
      }
    } finally {
      for (const video of live) { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); retired++ }
      live.clear(); URL.revokeObjectURL(url)
    }
    return { userAgent: navigator.userAgent, events, droppedEvents, captures, steps, failures,
      created: nextId - 1, opened, retired, liveVideos: document.querySelectorAll('video').length, sourceUrlRevoked: true }
  }, { requests, width: fixture.width, height: fixture.height })
  const observations = result.captures.map((capture) => {
    if (capture.pixels.length !== fixture.width * fixture.height * 4)
      return { ...capture, comparisons: [], closestFrames: [] }
    const comparisons = frames.map((frame) => {
      let absoluteError = 0, differentChannels = 0, maximumChannelDifference = 0
      for (let at = 0; at < frame.rgba.length; at++) {
        const distance = Math.abs(frame.rgba[at]! - capture.pixels[at]!)
        absoluteError += distance; differentChannels += Number(distance !== 0)
        maximumChannelDifference = Math.max(maximumChannelDifference, distance)
      }
      return { frameIndex: frame.index, presentationTime: frame.presentationTime,
        absoluteError, differentChannels, maximumChannelDifference }
    }), minimum = Math.min(...comparisons.map((comparison) => comparison.absoluteError))
    return { ...capture, rgbaSha256: hash(Uint8Array.from(capture.pixels)), comparisons,
      closestFrames: comparisons.filter((comparison) => comparison.absoluteError === minimum).map((comparison) => comparison.frameIndex) }
  })
  await info.attach('video-presentation-calibration', { contentType: 'application/json', body: JSON.stringify({
    schema: 1, commit: process.env.GITHUB_SHA, buildManifestSha256: hash(manifestBytes),
    scope: 'Independent real HTMLVideoElement observations; distances and ties do not prove a correct product frame or relax product assertions.',
    freshScope: 'New decoder of the identical source container, not the rewritten selected-audio MP4 variant.',
    fixture: { ...fixture, frames: fixture.frames }, numberedInput: manifest.numberedInput, requests,
    status: result.failures.length ? 'incomplete' : result.steps.some((step) => step.status === 'timed-out')
      ? 'observed-with-missing-callbacks' : 'observed',
    ...result, captures: observations, pageErrors,
  }) })
  expect(pageErrors).toEqual([])
  expect(result.failures).toEqual([])
  expect(result.droppedEvents).toBe(0)
  expect(result.steps).toHaveLength(requests.length * 2)
  // Every initial decoder and every requested seek still owes a complete
  // settled image, even when its earlier compositor callback had no data yet.
  expect(result.captures.filter((capture) => !capture.stage.endsWith('/callback')))
    .toHaveLength(requests.length * 2 + requests.length + 1)
  expect(result.captures.every((capture) => capture.error === null)).toBe(true)
  expect(result.steps.some((step) => step.status === 'media-error' || step.status === 'exception')).toBe(false)
  expect(result.retired).toBe(result.created)
  expect(result.opened).toBe(requests.length + 1)
  expect(result.liveVideos).toBe(0)
  expect(result.sourceUrlRevoked).toBe(true)
})
