import { test, expect } from '../helpers/library-browser.ts'
import { prepareOffline } from '../helpers/offline-browser.ts'
import { pwaServer } from '../helpers/pwa-server.ts'
import { readFileSync } from 'node:fs'
import { evaluate } from '../helpers/browser-expression.ts'
for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: Vorbis, AudioWorklet and MP4 components start offline from the saved game`, async ({
    page,
  }) => {
    const server = await pwaServer()
    try {
      await page.goto(server.url + `?backend=${backend}`)
      await page.locator('#files').setInputFiles([
        {
          name: 'startup.tjs',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            `var w=new Window();w.visible=true;w.setInnerSize(64,48);var layer=new Layer(w,null);layer.setSize(64,48);layer.fillRect(0,0,64,48,0xff334455);var ogg=new WaveSoundBuffer(null);ogg.open("tone.ogg");ogg.looping=true;ogg.play();var movie=new VideoOverlay(w);movie.visible=true;movie.setBounds(0,0,64,48);movie.open("clip.mp4");movie.frame=6;Debug.message("offline-media="+ogg.frequency+","+movie.numberOfAudioStream);`,
          ),
        },
        {
          name: 'tone.ogg',
          mimeType: 'audio/ogg',
          buffer: readFileSync(new URL('../fixtures/audio/tone.ogg', import.meta.url)),
        },
        {
          name: 'clip.mp4',
          mimeType: 'video/mp4',
          buffer: readFileSync(new URL('../fixtures/video/colors-sound.mp4', import.meta.url)),
        },
      ])
      await expect(page.locator('#logs')).toContainText('offline-media=44100,1')
      await expect(page.locator('#save-library')).toBeEnabled()
      await page.locator('#library-title').fill('Offline media')
      await page.locator('#save-library').click()
      await expect(page.locator('#library-games h3')).toHaveText('Offline media')
      await prepareOffline(page)
      await server.close()
      await page.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
      await expect(page.locator('#logs')).toContainText('offline-media=44100,1')
      await expect(page.locator('#evaluate')).toBeEnabled()
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音')
        await page.locator('#sound-toggle').click()
      await expect
        .poll(() =>
          page
            .locator('#sound-level')
            .evaluate((node) => Number((node as HTMLElement).dataset.maxPeak)),
        )
        .toBeGreaterThan(0.1)
      await evaluate(page, 'movie.numberOfFrame>6', '1')
      await expect(page.locator('video')).toBeVisible()
      await page.locator('#stop').click()
      await expect(page.locator('#stop')).toBeDisabled()
    } finally {
      await server.close()
    }
  })
