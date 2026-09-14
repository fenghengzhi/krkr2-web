// Opt-in instrumentation of the original image test; application sources are unchanged.
import { test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const prefix = String.raw`
(()=>{
  let serial=0;const pending=new Map(),events=[];
  const emit=value=>postMessage({__fontDiagnostic:value});
  globalThis.__fontTraceBegin=(kind,name,control)=>{const id=++serial;const item={kind,name,time:performance.now()};pending.set(id,item);if(control)globalThis.__fontTraceControl=control;emit({event:'begin',id,...item});return id};
  globalThis.__fontTraceEnd=id=>{const item=pending.get(id);if(item){events.push({...item,duration:performance.now()-item.time});if(events.length>2000)events.shift();pending.delete(id);emit({event:'end',id,time:performance.now()})}};
  const wrap=(prototype,name,kind)=>{const original=prototype[name];prototype[name]=function(...args){const id=globalThis.__fontTraceBegin(kind,this.size??name);let result;try{result=original.apply(this,args)}catch(error){globalThis.__fontTraceEnd(id);throw error}result.then(()=>globalThis.__fontTraceEnd(id),()=>globalThis.__fontTraceEnd(id));return result}};
  wrap(Blob.prototype,'arrayBuffer','blob');wrap(ReadableStreamDefaultReader.prototype,'read','stream');wrap(ReadableStreamDefaultReader.prototype,'cancel','stream-cancel');
  globalThis.__fontTraceNext=work=>{const id=globalThis.__fontTraceBegin('generator','next');try{return work.next()}finally{globalThis.__fontTraceEnd(id)}};
  let heartbeat=0;setInterval(()=>{heartbeat++;emit({event:'heartbeat',heartbeat,time:performance.now(),control:globalThis.__fontTraceControl&&{paused:globalThis.__fontTraceControl.paused,cancelled:globalThis.__fontTraceControl.cancelled}})},100);
  addEventListener('message',event=>emit({event:'rpc',name:event.data?.argumentList?.[0]?.value,time:performance.now()}));
  emit({event:'loaded',time:performance.now()});
  globalThis.__fontTraceSnapshot=()=>({heartbeat,pending:[...pending.values()].map(item=>({...item,age:performance.now()-item.time})),events,control:globalThis.__fontTraceControl&&{paused:globalThis.__fontTraceControl.paused,cancelled:globalThis.__fontTraceControl.cancelled}});
})();
`
function instrument(source: string): string {
  const pattern = /(?:async )?(hostCall|run|present|finishGraphics)\(([^)]*)\)\{/g
  const matches = [...source.matchAll(pattern)]
  for (const match of matches.reverse()) {
    const params = match[2]!.split(','),
      start = match.index! + match[0].length
    let end = start,
      depth = 1,
      quote = ''
    for (; depth; end++) {
      const ch = source[end]!
      if (quote) {
        if (ch === '\\') {
          end++
          continue
        }
        if (ch === quote) quote = ''
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    const name =
      match[1] === 'hostCall'
        ? `this.readText(${params[1]},${params[2]})`
        : match[1] === 'run'
          ? `${params[0]}==='krkr_execute'?this.readText(${params[1]}[3]):${params[0]}`
          : JSON.stringify(match[0])
    const body = source.slice(start, end - 1)
    source =
      source.slice(0, start) +
      `const __fontId=globalThis.__fontTraceBegin(${JSON.stringify(match[1])},${name},this.control);try{` +
      body +
      '}finally{globalThis.__fontTraceEnd(__fontId)}' +
      source.slice(end - 1)
  }
  if (
    matches.filter((m) => m[1] === 'hostCall').length !== 1 ||
    matches.filter((m) => m[1] === 'run').length !== 1
  )
    throw new Error('Unexpected runtime methods')
  return prefix + source
}
test.beforeEach(async ({ page }) => {
  if (process.env.KRKR_STARTUP_TRACE === '0') return
  await page.addInitScript(() => {
    const original = Worker,
      records: unknown[] = []
    Object.assign(globalThis, { __fontRecords: records })
    globalThis.Worker = class extends original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event) => {
          if (!event.data?.__fontDiagnostic) return
          event.stopImmediatePropagation()
          records.push({
            url: String(url),
            received: performance.now(),
            ...event.data.__fontDiagnostic,
          })
          if (records.length > 10000) records.shift()
        })
      }
    }
  })
  await page.route('**/assets/session.worker-*.js', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, body: instrument(await response.text()) })
  })
})
test.afterEach(async ({ page }, info) => {
  if (info.status !== 'passed' && info.status !== 'interrupted' && process.platform === 'darwin') {
    const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,comm='])
    const processes = stdout
      .split('\n')
      .filter((line) => line.includes('/ms-playwright/') && line.includes('WebContent.Development'))
    await Promise.all(
      processes.map(async (line) => {
        const pid = line.trim().split(/\s+/)[0]!,
          path = info.outputPath(`worker-stack-${pid}.txt`)
        await execute('/usr/bin/sample', [pid, '1', '1', '-file', path], { timeout: 8000 }).catch(
          () => {},
        )
        await info
          .attach(`worker-stack-${pid}`, { path, contentType: 'text/plain' })
          .catch(() => {})
      }),
    )
  }
  const records = await Promise.race([
    page
      .evaluate(() => (globalThis as unknown as { __fontRecords: unknown[] }).__fontRecords)
      .catch((error) => ({ error: String(error) })),
    new Promise((resolve) =>
      setTimeout(() => resolve({ error: 'page inspection timed out' }), 2000),
    ),
  ])
  await info.attach('startup-streaming-spans', {
    body: JSON.stringify(records ?? [], null, 2),
    contentType: 'application/json',
  })
  const workers = []
  for (const worker of page.workers())
    if (worker.url().includes('session.worker')) {
      const state = await Promise.race([
        worker
          .evaluate(() =>
            (globalThis as unknown as { __fontTraceSnapshot(): unknown }).__fontTraceSnapshot(),
          )
          .catch((error) => ({ error: String(error) })),
        new Promise((resolve) =>
          setTimeout(() => resolve({ error: 'worker inspection timed out' }), 2000),
        ),
      ])
      workers.push({ url: worker.url(), state })
    }
  await info.attach('startup-async-spans', {
    body: JSON.stringify(workers, null, 2),
    contentType: 'application/json',
  })
})
if (process.env.KRKR_STARTUP_MEDIA === '1') await import('../browser/activity-media.spec.ts')
else await import('../browser/image-writing.spec.ts')
