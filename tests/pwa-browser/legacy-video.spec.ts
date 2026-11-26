import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { prepareOffline } from '../helpers/offline-browser.ts'
import { pwaServer } from '../helpers/pwa-server.ts'

const game = `
var w=new Window();w.caption="Offline opening";w.setInnerSize(96,64);
var root=new Layer(w,null);w.add(root);root.setSize(96,64);root.fillRect(0,0,96,64,0xff203040);
var movie=new VideoOverlay(w);movie.setBounds(0,0,96,64);
root.onClick=function(){
 global.movie.open("opening.avi");global.movie.visible=true;global.movie.pause();global.movie.frame=50;
 global.Debug.message("offline-film:"+global.movie.originalWidth+"x"+global.movie.originalHeight
  +":"+global.movie.numberOfFrame+":"+global.movie.numberOfAudioStream+":"+global.movie.frame);
};
w.visible=true;Debug.message("offline-film-menu");`

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: a saved AVI cutscene first opens after the subpath PWA server shuts down`, async ({ page }, info) => {
    test.setTimeout(150000)
    const server = await pwaServer(), errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(server.url + '?backend=' + backend)
      test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(game) },
        { name: 'opening.avi', mimeType: 'video/x-msvideo', buffer: await readFile('out/verification/video-tracks/legacy-mjpeg.avi') },
      ])
      await expect(page.getByText('offline-film-menu', { exact: true })).toBeVisible()
      await expect(page.locator('video[data-video-id]')).toHaveCount(0)
      await page.locator('#library-title').fill('Offline AVI')
      await page.locator('#save-library').click()
      await expect(page.locator('#library-games h3')).toHaveText('Offline AVI')
      await prepareOffline(page)
      await server.close()
      await page.reload()
      await expect(page.locator('#offline-panel')).toHaveAttribute('data-ready', 'true')
      await page.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
      await expect(page.getByText('offline-film-menu', { exact: true })).toBeVisible()
      await page.locator('#stage canvas[data-window-id]').click()
      await expect(page.getByText('offline-film:96x64:100:1:50', { exact: true })).toBeVisible({ timeout: 90000 })
      const video = page.locator('video[data-video-id]')
      await expect(video).toBeVisible()
      await expect.poll(() => video.evaluate((element) => {
        const canvas = document.createElement('canvas')
        canvas.width = 96; canvas.height = 64
        const context = canvas.getContext('2d')!
        context.drawImage(element as HTMLVideoElement, 0, 0, 96, 64)
        const pixel = context.getImageData(48, 32, 1, 1).data
        return pixel[1]! > 140 && pixel[0]! < 85 && pixel[2]! < 85
      })).toBe(true)
      await info.attach('offline-avi-frame-50', { body: await video.screenshot(), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } finally {
      try { if (!page.isClosed() && await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter') }
      finally { await server.close() }
    }
  })
