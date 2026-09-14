"""Compile extracted reference event functions against inert platform stubs.

The emitted traces cover posting/delivery order, not GUI, TJS execution or clocks.
The actual TJS VM and closure identities are tested separately in TypeScript.
"""
import hashlib, json, pathlib, re, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT.parent / 'kirikiroid2-web/cpp/core/base/EventIntf.cpp'
OUT = ROOT / 'out/verification/system-events/native'
OUT.mkdir(parents=True, exist_ok=True)
source = SOURCE.read_text()

def function(name):
    match = re.search(r'^(?:static\s+)?(?:void|bool)\s+' + re.escape(name) + r'\([^;]*?\)\s*(?://[^\n]*\n)?\s*\{', source, re.M)
    if not match: raise RuntimeError('Missing reference function ' + name)
    start = source.index('{', match.start())
    depth, i, quote = 1, start + 1, None
    while depth:
        if quote:
            if source[i] == '\\': i += 2; continue
            if source[i] == quote: quote = None
        elif source.startswith('//', i): i = source.index('\n', i); continue
        elif source.startswith('/*', i): i = source.index('*/', i) + 2; continue
        elif source[i] in '\"\'': quote = source[i]
        elif source[i] == '{': depth += 1
        elif source[i] == '}': depth -= 1
        i += 1
    return source[match.start():i]

names = ['TVPPostEvent', '_TVPDeliverEventByPrio', '_TVPDeliverAllEvents2', '_TVPDeliverAllEvents',
         'TVPDeliverAllEvents', 'TVPPostInputEvent', '_TVPDeliverContinuousEvent',
         'TVPDeliverContinuousEvent', 'TVPAddContinuousHandler', 'TVPRemoveContinuousHandler']
extracted = '\n\n'.join(function(name) for name in names)
(OUT / 'reference.inc').write_text('// Copyright (C) 2000 W.Dee and contributors.\n// Extracted from EventIntf.cpp; original source and hashes are recorded in events.json.\n' + extracted)
header = r'''
#include <algorithm>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
using tjs_int=int;using tjs_int64=int64_t;using tjs_uint=unsigned;using tjs_uint32=uint32_t;using tjs_uint64=uint64_t;using tjs_error=int;using ttstr=std::string;
#define TVP_EPT_POST 0
#define TVP_EPT_REMOVE_POST 1
#define TVP_EPT_IMMEDIATE 2
#define TVP_EPT_DISCARDABLE 0x10
#define TVP_EPT_NORMAL 0
#define TVP_EPT_EXCLUSIVE 0x20
#define TVP_EPT_IDLE 0x40
#define TVP_EPT_PRIO_MASK 0xe0
#define TVP_EPT_METHOD_MASK 0xf
#define TVP_HAS_WCHAIN_CONTINUOUS_EVENT_TRACE 0
#define TJS_W(s) s
#define TJS_FAILED(v) ((v)<0)
#define TJS_CONVERT_TO_TJS_EXCEPTION catch(...){throw;}
#define TVP_CATCH_AND_SHOW_SCRIPT_EXCEPTION(s) catch(...){throw;}
std::vector<std::string> trace;
uint64_t tick=17;
struct tTJSVariant { int64_t number; tTJSVariant(int64_t n=0):number(n){} };
struct iTJSDispatch2 { std::string name; std::function<void(iTJSDispatch2*,int64_t)> run; int refs=0; void AddRef(){refs++;}void Release(){refs--;} };
struct tTJSVariantClosure {
 iTJSDispatch2 *Object=nullptr,*ObjThis=nullptr;
 bool operator==(const tTJSVariantClosure& other)const{return Object==other.Object&&ObjThis==other.ObjThis;}
 void AddRef(){if(Object)Object->AddRef();if(ObjThis)ObjThis->AddRef();}
 void Release(){if(Object)Object->Release();if(ObjThis)ObjThis->Release();}
 int FuncCall(int,const char*,void*,void*,unsigned n,tTJSVariant**args,void*){
  if(!Object)return -1;Object->run(ObjThis,n?args[0]->number:0);return 0;
 }
};
uint64_t TVPEventSequenceNumber=0,TVPEventSequenceNumberToProcess=0;
bool TVPExclusiveEventPosted=false,TVPEventDisabled=false,TVPEventInterrupting=false,enabled=true;
bool TVPProcessContinuousHandlerEventFlag=false,TVPContinuousEventProcessing=false;
struct tTVPEvent {
 iTJSDispatch2 *target,*source;std::string name;unsigned tag,flags;uint64_t seq;
 tTVPEvent(iTJSDispatch2*t,iTJSDispatch2*s,ttstr&n,unsigned tag,unsigned,tTJSVariant*,unsigned f):target(t),source(s),name(n),tag(tag),flags(f),seq(TVPEventSequenceNumber){}
 void Deliver(){target->run(target,0);}auto GetTargetNoAddRef(){return target;}auto GetSourceNoAddRef(){return source;}
 auto&GetEventName(){return name;}unsigned GetTag(){return tag;}unsigned GetFlags(){return flags;}uint64_t GetSequence(){return seq;}
};
struct tTVPBaseInputEvent { iTJSDispatch2*target;void Deliver(){target->run(target,0);}void*GetSource(){return target;}unsigned GetTag(){return 0;} };
struct tTVPContinuousEventCallbackIntf{void OnContinuousCallback(uint64_t){}};
std::vector<tTVPEvent*> TVPEventQueue;
std::vector<tTVPBaseInputEvent*> TVPInputEventQueue;
std::vector<tTVPContinuousEventCallbackIntf*> TVPContinuousEventVector;
std::vector<tTJSVariantClosure> TVPContinuousHandlerVector;
void TVPInvokeEvents(){}void TVPEventReceived(){}void TVPCallDeliverAllEventsOnIdle(){}
bool TVPGetSystemEventDisabledState(){return !enabled;}
void TVPCancelInputEvents(void*source,unsigned){for(auto i=TVPInputEventQueue.begin();i!=TVPInputEventQueue.end();){if((*i)->GetSource()==source){delete*i;i=TVPInputEventQueue.erase(i);}else ++i;}}
void TVPStartTickCount(){}uint64_t TVPGetTickCount(){return tick;}
void TVPBeginContinuousEvent(){}void TVPEndContinuousEvent(){}
void TVPDeliverWindowUpdateEvents(){}void TVPDeliverContinuousEvent();
'''
main = r'''
#include "reference.inc"
std::vector<std::unique_ptr<iTJSDispatch2>> objects;
iTJSDispatch2* make(std::string name){auto p=std::make_unique<iTJSDispatch2>();p->name=name;p->run=[name](auto*,auto){trace.push_back(name);};auto*r=p.get();objects.push_back(std::move(p));return r;}
void post(iTJSDispatch2* target,unsigned flags=0){std::string name="event";TVPPostEvent(target,target,name,0,flags,0,nullptr);}
void input(iTJSDispatch2* target){TVPPostInputEvent(new tTVPBaseInputEvent{target},0);}
void add(iTJSDispatch2* target){TVPAddContinuousHandler({target,target});}
void remove(iTJSDispatch2* target){TVPRemoveContinuousHandler({target,target});}
void reset(){for(auto*p:TVPEventQueue)delete p;for(auto*p:TVPInputEventQueue)delete p;TVPEventQueue.clear();TVPInputEventQueue.clear();for(auto c:TVPContinuousHandlerVector)c.Release();TVPContinuousHandlerVector.clear();objects.clear();trace.clear();TVPEventSequenceNumber=TVPEventSequenceNumberToProcess=0;TVPExclusiveEventPosted=TVPEventDisabled=TVPEventInterrupting=TVPProcessContinuousHandlerEventFlag=TVPContinuousEventProcessing=false;enabled=true;}
void output(const char*name){std::cout<<name<<'\t';for(size_t i=0;i<trace.size();i++){if(i)std::cout<<',';std::cout<<trace[i];}std::cout<<'\n';reset();}
int main(){
 {auto*n=make("N"),*i=make("I"),*e=make("E"),*k=make("K"),*c=make("C");post(n);input(k);post(i,TVP_EPT_IDLE);post(e,TVP_EPT_EXCLUSIVE);add(c);TVPProcessContinuousHandlerEventFlag=true;TVPDeliverAllEvents();output("groups");}
 for(auto group:{TVP_EPT_NORMAL,TVP_EPT_EXCLUSIVE,TVP_EPT_IDLE}){
  auto*a=make("A"),*b=make("B"),*x=make("X");a->run=[&](auto*,auto){trace.push_back("A");post(x,TVP_EPT_EXCLUSIVE);};post(a,group);post(b,group);TVPDeliverAllEvents();trace.push_back("P");TVPDeliverAllEvents();output(group==TVP_EPT_NORMAL?"normal-exclusive":group==TVP_EPT_EXCLUSIVE?"exclusive-exclusive":"idle-exclusive");
 }
 {auto*a=make("A"),*b=make("B"),*x=make("X");a->run=[&](auto*,auto){trace.push_back("A");post(x,TVP_EPT_EXCLUSIVE);};input(a);input(b);TVPDeliverAllEvents();trace.push_back("P");TVPDeliverAllEvents();output("input-exclusive");}
 {auto*a=make("A"),*b=make("B"),*x=make("X"),*m=make("M");a->run=[&](auto*,auto){trace.push_back("A");post(x,TVP_EPT_EXCLUSIVE);TVPDeliverAllEvents();trace.push_back("a");post(m);};post(a);post(b);TVPDeliverAllEvents();trace.push_back("P");TVPDeliverAllEvents();output("nested-generation");}
 {auto*a=make("A"),*b=make("B"),*c=make("C");a->run=[&](auto*,auto){trace.push_back("A");remove(b);add(c);remove(a);};c->run=[&](auto*,auto){trace.push_back("C");remove(c);};add(a);add(a);add(b);TVPProcessContinuousHandlerEventFlag=true;TVPDeliverAllEvents();output("live-continuous");}
 {auto*a=make("A"),*b=make("B");a->run=[&](auto*,auto){trace.push_back("A");TVPProcessContinuousHandlerEventFlag=true;TVPDeliverAllEvents();trace.push_back("a");};add(a);add(b);TVPProcessContinuousHandlerEventFlag=true;TVPDeliverAllEvents();output("continuous-reentry");}
 {auto*i=make("I"),*x=make("X"),*a=make("A"),*b=make("B");i->run=[&](auto*,auto){trace.push_back("I");post(x,TVP_EPT_EXCLUSIVE);};post(i,TVP_EPT_IDLE);add(a);add(b);TVPProcessContinuousHandlerEventFlag=true;TVPDeliverAllEvents();trace.push_back("P");TVPDeliverAllEvents();output("idle-before-continuous");}
 {auto*n=make("N"),*t=make("T"),*im=make("M");enabled=false;post(n);post(t,TVP_EPT_DISCARDABLE);post(im,TVP_EPT_IMMEDIATE);trace.push_back("P");enabled=true;TVPDeliverAllEvents();output("disabled-posting");}
}
'''
(OUT / 'oracle.cpp').write_text(header + main)
subprocess.run(['c++','-std=c++17','-O1','-g','-fsanitize=undefined,address',str(OUT/'oracle.cpp'),'-o',str(OUT/'oracle')],check=True)
result = subprocess.run([str(OUT/'oracle')],check=True,capture_output=True,text=True)
(OUT/'output.txt').write_text(result.stdout)
cases = {line.split('\t')[0]:line.split('\t')[1].split(',') for line in result.stdout.strip().splitlines()}
fixture = {'source':'kirikiroid2-web/cpp/core/base/EventIntf.cpp', 'sourceSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
 'extractedSha256':hashlib.sha256(extracted.encode()).hexdigest(),'functions':names,'cases':cases,
 'scope':'Exact extracted reference queue and continuous functions; inert platform/TJS invocation stubs, no GUI, VM or clock correctness claim.'}
(ROOT/'tests/fixtures/system-events/events.json').write_text(json.dumps(fixture,indent=2)+'\n')
print(json.dumps(cases,indent=2))
