import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserPadDownloads } from '../../src/backends/pad/browser.ts'

// Unit evidence for URL ownership only. The separate Playwright Pad cases
// prove actual browser downloads; this inert document never writes a file.
for (const boundary of ['click-stop', 'append-throw', 'click-throw'] as const) {
  test(`Pad download retires its actual Blob URL after ${boundary}`, async () => {
    let host: BrowserPadDownloads,
      removed = 0,
      clicked = 0
    const failure = new Error(boundary)
    const anchor = {
      href: '',
      download: '',
      hidden: false,
      click() {
        clicked++
        if (boundary === 'click-stop') host.dispose()
        else throw failure
      },
      remove() {
        removed++
      },
    }
    const document = {
      defaultView: {},
      createElement(tag: string) {
        assert.equal(tag, 'a')
        return anchor
      },
      body: {
        append(value: unknown) {
          assert.equal(value, anchor)
          if (boundary === 'append-throw') throw failure
        },
      },
    } as unknown as Document
    host = new BrowserPadDownloads(document)
    try {
      if (boundary === 'click-stop') host.download('pad.tjs', 'tiny\r\n雪')
      else
        assert.throws(
          () => host.download('pad.tjs', 'tiny\r\n雪'),
          (error) => error === failure,
        )
      assert.equal(removed, 1)
      assert.equal(clicked, boundary === 'append-throw' ? 0 : 1)
      assert.match(anchor.href, /^blob:/)
      assert.equal(anchor.download, 'pad.tjs')
      // Read the actual URL registry; a still-live URL would return the Blob.
      await assert.rejects(fetch(anchor.href))
      host.dispose()
      assert.throws(() => host.download('late.tjs', 'late'), { name: 'AbortError' })
    } finally {
      host.dispose()
      if (anchor.href) URL.revokeObjectURL(anchor.href)
    }
  })
}
