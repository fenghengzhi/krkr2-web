import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'

export interface MaintenanceObservation {
  worker: string
  sequence: number
  kind: 'compact' | 'debug'
  level?: number
  text?: string
}
declare global { interface Window {
  maintenanceProof: { entries: MaintenanceObservation[]; dropped: number }
  closeMaintenanceProof(): void
} }

/** The original, hash-checked module factory remains unchanged. The wrapper
 * observes its real host import's primitive arguments and forwards immediately;
 * it never calls compact, changes a result or generates application activity. */
export async function observeMaintenance(page: Page) {
  const channel = 'maintenance-' + randomUUID(), manifest = JSON.parse(await readFile('.generated/wasm/manifest.json', 'utf8')) as WasmManifest,
    assets = new Map(Object.values(manifest.variants).map((variant) => [variant!.mjs.file, variant!.mjs] as const)), originals = new Map<string, Buffer>()
  await page.addInitScript((channel) => {
    const observer = new BroadcastChannel(channel)
    window.maintenanceProof = { entries: [], dropped: 0 }
    observer.onmessage = ({ data }) => {
      if (window.maintenanceProof.entries.length >= 512) { window.maintenanceProof.dropped++; return }
      window.maintenanceProof.entries.push(data as MaintenanceObservation)
    }
    window.closeMaintenanceProof = () => observer.close()
  }, channel)
  await page.route((url) => url.pathname.startsWith('/wasm/') && url.pathname.endsWith('.mjs'), async (route) => {
    const url = new URL(route.request().url()), name = url.pathname.split('/').at(-1)!, pin = assets.get(name)
    if (!pin) throw new Error('Unrecognized native module in compact observation')
    if (url.searchParams.get('maintenance-original') === '1') {
      const body = originals.get(name)
      if (!body) throw new Error('Original native module was not preserved before wrapper import')
      await route.fulfill({ status: 200, contentType: 'text/javascript', body }); return
    }
    const response = await route.fetch(), body = await response.body()
    if (!response.ok() || body.length !== pin.bytes || createHash('sha256').update(body).digest('hex') !== pin.sha256)
      throw new Error('Compact observation native module differs from the hosted manifest')
    originals.set(name, body)
    url.searchParams.set('maintenance-original', '1')
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: `
import factory from ${JSON.stringify(url.href)};
export default async function(options){
  let module,sequence=0;const observer=new BroadcastChannel(${JSON.stringify(channel)});
  const read=(pointer,length)=>{let text="";for(let i=0;i<length&&i<4096;i++)text+=String.fromCharCode(module.HEAPU16[(pointer>>>1)+i]);return text;};
  const hostCall=options.hostCall;
  module=await factory({...options,hostCall:(vm,name,length,count,args)=>{
    if(module){
      const operation=read(name,length),pointer=count?module.HEAPU32[args>>>2]:0;
      if(operation==="System.doCompact")observer.postMessage({worker:self.name,sequence:++sequence,kind:"compact",level:Number(module._krkr_value_integer(pointer))});
      else if(operation==="Debug.message"&&pointer&&module._krkr_value_type(pointer)===2){
        const text=read(module._krkr_value_data(pointer),module._krkr_value_length(pointer));
        if(text.startsWith("maintenance:"))observer.postMessage({worker:self.name,sequence:++sequence,kind:"debug",text});
      }
    }
    return hostCall(vm,name,length,count,args);
  }});
  return module;
}
` })
  })
}

export const maintenanceSource = String.raw`
var fakeCompacts=0,continuousTicks=0,continuous=function(){continuousTicks++;};
System.doCompact=function(){fakeCompacts++;};System.addContinuousHandler(continuous);
System.onDeactivate=function(){Debug.message("maintenance:deactivate");};
var win=new Window();win.caption="Maintenance";win.setInnerSize(80,48);win.visible=true;
var root=new Layer(win,null);win.add(root);root.setSize(80,48);root.fillRect(0,0,80,48,0xff345678);
`
