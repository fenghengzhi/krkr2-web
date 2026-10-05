import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'

export interface RandomEntropyObservation {
  instance: string
  worker: string
  sequence: number
  kind: 'entropy' | 'debug' | 'armed'
  call?: number
  length?: number
  cryptoCalls?: number
  cryptoBytes?: number[]
  written?: number[]
  error?: string
  text?: string
  request?: string
}
declare global { interface Window {
  randomEntropyProof: { entries: RandomEntropyObservation[]; dropped: number }
  armRandomEntropy(instance: string, offset: number, request: string): void
  closeRandomEntropyProof(): void
} }

/** Observe the real, hash-checked factory and real Worker Web Crypto. The sole
 * intervention is an explicitly armed provider exception, used to verify that
 * failed reseeding preserves the old generator and remains a TJS exception. */
export async function observeRandomEntropy(page: Page) {
  const channel = 'random-entropy-' + randomUUID(),
    manifest = JSON.parse(await readFile('.generated/wasm/manifest.json', 'utf8')) as WasmManifest,
    assets = new Map(Object.values(manifest.variants).map((variant) => [variant!.mjs.file, variant!.mjs] as const)),
    originals = new Map<string, Buffer>()
  await page.addInitScript((channel) => {
    const observer = new BroadcastChannel(channel)
    window.randomEntropyProof = { entries: [], dropped: 0 }
    observer.onmessage = ({ data }) => {
      if (window.randomEntropyProof.entries.length >= 256) { window.randomEntropyProof.dropped++; return }
      window.randomEntropyProof.entries.push(data as RandomEntropyObservation)
    }
    window.armRandomEntropy = (instance, offset, request) => observer.postMessage({ type: 'arm', instance, offset, request })
    window.closeRandomEntropyProof = () => observer.close()
  }, channel)
  await page.context().route((url) => url.pathname.startsWith('/wasm/') && url.pathname.endsWith('.mjs'), async (route) => {
    const url = new URL(route.request().url()), name = url.pathname.split('/').at(-1)!, pin = assets.get(name)
    if (!pin) throw new Error('Unrecognized native module in entropy observation')
    if (url.searchParams.get('random-original') === '1') {
      const body = originals.get(name)
      if (!body) throw new Error('Original entropy module was not preserved')
      await route.fulfill({ status: 200, contentType: 'text/javascript', body }); return
    }
    const response = await route.fetch(), body = await response.body()
    if (!response.ok() || body.length !== pin.bytes || createHash('sha256').update(body).digest('hex') !== pin.sha256)
      throw new Error('Entropy observation module differs from the hosted manifest')
    originals.set(name, body)
    url.searchParams.set('random-original', '1')
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: `
import factory from ${JSON.stringify(url.href)};
export default async function(options){
  let module,sequence=0,calls=0,failAt=0,current;
  const observer=new BroadcastChannel(${JSON.stringify(channel)}),worker=self.name,
    instance=worker+":"+performance.timeOrigin+":"+performance.now(),
    publish=(data)=>observer.postMessage({instance,worker,sequence:++sequence,...data}),
    prototype=Object.getPrototypeOf(crypto),getRandomValues=prototype.getRandomValues;
  prototype.getRandomValues=function(array){
    if(current){
      current.cryptoCalls++;
      if(calls===failAt)throw new DOMException("random-provider-injected-failure","OperationError");
    }
    const result=Reflect.apply(getRandomValues,this,[array]);
    if(current)current.cryptoBytes=Array.from(new Uint8Array(result.buffer,result.byteOffset,result.byteLength));
    return result;
  };
  observer.onmessage=({data})=>{
    if(data.type!=="arm"||data.instance!==instance)return;
    failAt=calls+data.offset;publish({kind:"armed",request:data.request,call:failAt});
  };
  const read=(pointer,length)=>{let text="";for(let i=0;i<length&&i<4096;i++)text+=String.fromCharCode(module.HEAPU16[(pointer>>>1)+i]);return text;},
    hostCall=options.hostCall,randomBits=options.randomBits;
  module=await factory({...options,randomBits:(destination,length)=>{
    const proof={kind:"entropy",call:++calls,length,cryptoCalls:0};current=proof;
    try{const result=randomBits(destination,length);proof.written=Array.from(module.HEAPU8.subarray(destination,destination+length));return result;}
    catch(error){proof.error=String(error);throw error;}
    finally{current=undefined;publish(proof);}
  },hostCall:(vm,name,length,count,args)=>{
    if(module&&count&&read(name,length)==="Debug.message"){
      const pointer=module.HEAPU32[args>>>2];
      if(module._krkr_value_type(pointer)===2){
        const text=read(module._krkr_value_data(pointer),module._krkr_value_length(pointer));
        if(text.startsWith("random-proof:"))publish({kind:"debug",text});
      }
    }
    return hostCall(vm,name,length,count,args);
  }});
  return module;
}
` })
  })
}
