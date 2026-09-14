import { test, expect } from '@playwright/test'
import { wave, midi } from '../helpers/audio.ts'
import { readFileSync } from 'node:fs'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: AudioWorklet plays WAVE and MIDI with script callbacks and clean shutdown`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    const source = String.raw`
class Sound extends WaveSoundBuffer {
  function Sound(){super.WaveSoundBuffer(null);}
  function onStatusChanged(status){Debug.message("wave="+status);}
  function onLabel(name){Debug.message("label="+name);}
  function onFadeCompleted(){Debug.message("fade-done");stop();}
}
var sound=new Sound();sound.open("tone.wav");sound.flags[0]=2;sound.flags[0]++;sound.looping=true;sound.play();
Debug.message("audio-ready="+sound.flags[0]+","+sound.frequency);
var music=new MIDISoundBuffer(null);music.open("tone.mid");music.looping=true;
`
    await page.locator('#files').setInputFiles([
      { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
      {
        name: 'tone.wav',
        mimeType: 'audio/wav',
        buffer: Buffer.from(
          wave(
            Array.from({ length: 4410 }, (_, i) => Math.sin((i * 2 * Math.PI * 440) / 44100) * 0.3),
            44100,
          ),
        ),
      },
      {
        name: 'tone.wav.sli',
        mimeType: 'text/plain',
        buffer: Buffer.from('#2.00\nLabel {Position=882;Name="cue";}'),
      },
      {
        name: 'tone.mid',
        mimeType: 'audio/midi',
        buffer: Buffer.from(midi([[0, 0x90, 69, 100, 0x83, 0x60, 0x80, 69, 0, 0, 0xff, 0x2f, 0]])),
      },
    ])
    // setInputFiles does not supply user activation. Loading must finish even
    // if autoplay is suspended, before the separate explicit unlock gesture.
    await expect(page.locator('#logs')).toContainText('audio-ready=3,44100')
    await expect(page.locator('#evaluate')).toBeEnabled()
    if ((await page.locator('#sound-toggle').textContent()) === '开启声音')
      await page.locator('#sound-toggle').click()
    await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
    await expect
      .poll(() =>
        page.locator('#sound-level').evaluate((el) => Number((el as HTMLElement).dataset.maxPeak)),
      )
      .toBeGreaterThan(0.1)
    await expect(page.locator('#logs')).toContainText('label=cue')
    await evaluate(
      page,
      '(function(){sound.paused=true;sound.samplePosition=2205;return sound.samplePosition+","+sound.status;})()',
      '2205,play',
    )
    await evaluate(page, 'sound.samplePosition', '2205')
    await evaluate(
      page,
      '(function(){sound.paused=false;sound.fade(0,120);return "fading";})()',
      'fading',
    )
    await expect(page.locator('#logs')).toContainText('fade-done')
    await expect(page.locator('#logs p span').last()).toHaveText('wave=stop')
    await evaluate(page, '(function(){music.play();return music.status;})()', 'play')
    await expect
      .poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value))
      .toBeGreaterThan(0.01)
    await page.locator('#sound-toggle').click()
    await expect(page.locator('#sound-status')).toHaveText('声音已静音。')
    await page.locator('#stop').click()
    await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
    await expect(page.locator('#sound-toggle')).toBeDisabled()
    expect(errors).toEqual([])
  })

  test(`${backend}: browser codecs retain Vorbis and MPEG source sample positions`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(String.raw`
class Sound extends WaveSoundBuffer {
  function Sound(){super.WaveSoundBuffer(null);}
  function onLabel(name){Debug.message("encoded-label="+name);}
}
var ogg=new Sound();ogg.open("tone.ogg");ogg.looping=true;
var mp3=new Sound();mp3.open("tone.mp3");mp3.looping=true;
Debug.message("encoded-ready="+ogg.frequency+","+mp3.frequency+","+ogg.totalTime);ogg.play();
`),
      },
      ...['ogg', 'mp3'].flatMap((extension) => [
        {
          name: `tone.${extension}`,
          mimeType: extension === 'ogg' ? 'audio/ogg' : 'audio/mpeg',
          buffer: readFileSync(new URL(`../fixtures/audio/tone.${extension}`, import.meta.url)),
        },
        {
          name: `tone.${extension}.sli`,
          mimeType: 'text/plain',
          buffer: Buffer.from(
            `#2.00\nLabel {Position=4410;Name="${extension}";}\n${extension === 'ogg' ? 'Label {Position=11000;Name="ogg-tail";}' : ''}`,
          ),
        },
      ]),
    ])
    await expect(page.locator('#logs')).toContainText('encoded-ready=44100,44100,250')
    await expect(page.locator('#evaluate')).toBeEnabled()
    if ((await page.locator('#sound-toggle').textContent()) === '开启声音')
      await page.locator('#sound-toggle').click()
    await expect(page.locator('#logs')).toContainText('encoded-label=ogg')
    await expect(page.locator('#logs')).toContainText('encoded-label=ogg-tail')
    await expect
      .poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value))
      .toBeGreaterThan(0.1)
    await evaluate(page, '(function(){ogg.stop();return ogg.labels.ogg.position;})()', '100')
    await expect
      .poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value))
      .toBe(0)
    await evaluate(page, '(function(){mp3.play();return mp3.frequency;})()', '44100')
    await expect(page.locator('#logs')).toContainText('encoded-label=mp3')
    await expect
      .poll(() => page.locator('#sound-level').evaluate((el) => (el as HTMLMeterElement).value))
      .toBeGreaterThan(0.1)
    await page.locator('#stop').click()
    await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
  })
}
