import type { Page } from '@playwright/test'

export const systemApplicationSource = String.raw`
System.exitOnWindowClose=false;
var applicationTrace=[];
function applicationMark(name){applicationTrace.add(name);Debug.message("system-application:"+applicationTrace.join("|"));}
System.onActivate=function(args*){if(args.count)throw "activate arguments";applicationMark("activate");};
System.onDeactivate=function(args*){if(args.count)throw "deactivate arguments";applicationMark("deactivate");};
class ApplicationWindow extends Window {
 function ApplicationWindow(name,x){
  super.Window();caption=name;setPos(x,0);visible=true;
  var root=new Layer(this,null);add(root);root.setSize(100,70);root.fillRect(0,0,100,70,0xff345678);
  var menu=new MenuItem(this,"Application tools"),item=new MenuItem(this,"Application item");menu.add(item);this.menu.add(menu);setInnerSize(100,70);
 }
}
var applicationA=new ApplicationWindow("Application A",0),applicationB=new ApplicationWindow("Application B",250);
`
export interface ApplicationEvidence {
  events: { type: string; trusted: boolean; windowTarget: boolean; focused: boolean; visibility: string; at: number }[]
  messages: { generation: number; sequence: number; active: boolean }[]
  dropped: number
}
declare global { interface Window { systemApplicationEvidence: ApplicationEvidence } }
export async function observeApplication(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proof: ApplicationEvidence = { events: [], messages: [], dropped: 0 }
    window.systemApplicationEvidence = proof
    const record = (event: Event) => {
      if (proof.events.length >= 512) { proof.dropped++; return }
      proof.events.push({ type: event.type, trusted: event.isTrusted, windowTarget: event.target === window,
        focused: document.hasFocus(), visibility: document.visibilityState, at: performance.now() })
    }
    for (const type of ['focus', 'blur', 'pageshow', 'pagehide']) window.addEventListener(type, record, true)
    for (const type of ['visibilitychange', 'freeze', 'resume']) document.addEventListener(type, record, true)
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = new Proxy(post, {
      apply(target, receiver, args) {
        const packet = args[0] as { type?: string; argumentList?: Array<{ value?: unknown }> }, values = packet?.argumentList
        if (packet?.type === 'APPLY' && values?.[0]?.value === 'applicationActivation') {
          const generation = values[1]?.value, value = values[2]?.value as { sequence?: number; active?: boolean } | undefined
          if (proof.messages.length >= 512) proof.dropped++
          else proof.messages.push({ generation: Number(generation), sequence: Number(value?.sequence), active: !!value?.active })
        }
        return Reflect.apply(target, receiver, args)
      },
    })
  })
}
