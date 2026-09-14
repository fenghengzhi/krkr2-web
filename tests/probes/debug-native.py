"""Compile original KRKR2 log/history/error functions with controlled clock and sink.

The test sink excludes native OS file opening and banner formatting. The actual
history, hundred-entry trimming, importance, rollback and start/error functions
are extracted without edits. No production TypeScript participates in generation.
"""
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'out/verification/debug/reference/krkr2-DebugIntf.cpp'
OUT = ROOT / 'out/verification/debug/native'
OUT.mkdir(parents=True, exist_ok=True)

def extract(source, marker):
    start = source.index(marker)
    at = source.index('{', start) + 1
    depth, quote = 1, None
    while depth:
        if quote:
            if source[at] == '\\':
                at += 2
                continue
            if source[at] == quote:
                quote = None
        elif source.startswith('//', at):
            at = source.index('\n', at)
            continue
        elif source.startswith('/*', at):
            at = source.index('*/', at) + 2
            continue
        elif source[at] in '\"\'':
            quote = source[at]
        elif source[at] == '{':
            depth += 1
        elif source[at] == '}':
            depth -= 1
        at += 1
    return source[start:at]

source = SOURCE.read_text()
functions = [
    'void TVPAddLog(const ttstr &line, bool appendtoimportant)',
    'ttstr TVPGetLastLog(tjs_uint n)',
    'void TVPStartLogToFile(bool clear)',
    'void TVPOnError()',
]
extracted = '\n\n'.join(extract(source, marker) for marker in functions) + '\n'
(OUT / 'reference.inc').write_text(extracted)
header = r'''
#include <algorithm>
#include <cstdint>
#include <ctime>
#include <deque>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>
using tjs_char=char16_t;using tjs_int=int;using tjs_uint=uint32_t;
#define TJS_W(value) u##value
#define TJS_TEXT_OUT_CRLF
struct tTJSStringBufferLength {size_t n;explicit tTJSStringBufferLength(size_t n):n(n){}};
struct ttstr {
 std::u16string value;
 ttstr()=default;ttstr(const char16_t* s):value(s){}ttstr(std::u16string s):value(s){}
 ttstr(tTJSStringBufferLength n):value(n.n,0){}
 size_t GetLen()const{return value.size();}const char16_t* c_str()const{return value.c_str();}
 char16_t* Independ(){return value.data();}
 ttstr& operator+=(const ttstr& b){value+=b.value;return *this;}
 friend ttstr operator+(const ttstr&a,const ttstr&b){return ttstr(a.value+b.value);}
};
size_t TJS_strlen(const char16_t* s){return std::char_traits<char16_t>::length(s);}
void TJS_strcpy(char16_t* d,const char16_t* s){std::char_traits<char16_t>::copy(d,s,TJS_strlen(s)+1);}
size_t TJS_strftime(char16_t* d,size_t,const char16_t*,const tm*){TJS_strcpy(d,u"12:34:56");return 8;}
time_t fixedTime(time_t* dest){if(dest)*dest=1000;return 1000;}
tm* fixedLocaltime(const time_t*){static tm value{};return &value;}
#define time fixedTime
#define localtime fixedLocaltime
struct tTVPLogItem {ttstr Log,Time;tTVPLogItem(const ttstr&l,const ttstr&t):Log(l),Time(t){}};
static std::deque<tTVPLogItem> deque;
static ttstr important;
static auto* TVPLogDeque=&deque;
static auto* TVPImportantLogs=&important;
static tjs_uint TVPLogMaxLines=2048,TVPLogToFileRollBack=100;
static bool TVPAutoLogToFileOnError=true,TVPAutoClearLogOnError=false,TVPLoggingToFile=false;
void TVPEnsureLogObjects(){}
void TVPOnErrorHook(){} // Platform UI hook; excluded from the log/history oracle.
static std::u16string observed;
void onLog(const ttstr& line){observed+=line.value+u"\r\n";}
void (*TVPOnLog)(const ttstr&)=onLog;
struct Sink {std::u16string data;void Clear(){data.clear();}void Log(const ttstr&s){data+=s.value+u"\r\n";}};
static Sink TVPLogStreamHolder;
'''
driver = r'''
void hex(const std::u16string& value){
 const char* digits="0123456789abcdef";
 for(uint16_t c:value){for(unsigned b:{unsigned(c&255),unsigned(c>>8)})std::cout<<digits[b>>4]<<digits[b&15];}
}
int main(){
 for(int count:{0,1,99,100,101,2047,2048,2147,2148,2199,2248,4097})
 for(int automatic:{0,1})for(int clear:{0,1})for(int force:{0,1}){
  deque.clear();important.value.clear();observed.clear();TVPLoggingToFile=false;
  TVPAutoLogToFileOnError=automatic;TVPAutoClearLogOnError=clear;
  TVPLogStreamHolder.data=u"PREVIOUS\r\n";
  for(int i=0;i<count;i++){
   auto number=std::to_string(i);std::u16string line=u"row-";
   for(char c:number)line+=char16_t(c);line+=u"漢";
   TVPAddLog(ttstr(line),i%37==0);
  }
  if(force)TVPStartLogToFile(clear);else TVPOnError();
  if(force||automatic)TVPStartLogToFile(!clear);
  TVPAddLog(u"after",false);
  std::cout<<count<<'\t'<<automatic<<'\t'<<clear<<'\t'<<force;
  for(auto n:{0u,1u,100u,0xffffffffu}){std::cout<<'\t';hex(TVPGetLastLog(n).value);}
  std::cout<<'\t';hex(TVPLogStreamHolder.data);std::cout<<'\t';hex(observed);std::cout<<'\n';
 }
}
'''
(OUT / 'driver.cpp').write_text(header + '\n#include "reference.inc"\n' + driver)
command = ['clang++', '-std=c++20', '-O1', '-fsanitize=address,undefined',
           '-fno-omit-frame-pointer', str(OUT / 'driver.cpp'), '-o', str(OUT / 'reference')]
subprocess.run(command, check=True)
run = subprocess.run([str(OUT / 'reference')], capture_output=True, check=True)
(OUT / 'stdout.txt').write_bytes(run.stdout)
(OUT / 'stderr.txt').write_bytes(run.stderr)
assert not run.stderr, run.stderr
cases = []
for line in run.stdout.decode('ascii').splitlines():
    fields = line.split('\t')
    assert len(fields) == 10
    count, automatic, clear, force = map(int, fields[:4])
    hashes = [hashlib.sha256(bytes.fromhex(field)).hexdigest() for field in fields[4:]]
    cases.append(dict(count=count, automatic=bool(automatic), clear=bool(clear), force=bool(force),
                      history=dict(zip(['0','1','100','4294967295'], hashes[:4])),
                      file=hashes[4], observers=hashes[5]))
assert len(cases) == 96
result = dict(source=str(SOURCE.relative_to(ROOT)),
              sourceUrl='https://github.com/krkrz/krkr2/blob/master/kirikiri2/trunk/kirikiri2/src/core/utils/DebugIntf.cpp',
              sourceSha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
              extractedSha256=hashlib.sha256(extracted.encode()).hexdigest(),
              driverSha256=hashlib.sha256((OUT/'driver.cpp').read_bytes()).hexdigest(),
              sanitizers=['address','undefined'], compiler=command,
              scope='Original KRKR2 history/importance/start/error functions; controlled UTF-16 string, clock and file sink. OS file opening/banner, error UI hook and script callbacks are not part of this native oracle.',
              cases=cases)
fixture = ROOT / 'tests/fixtures/debug/native.json'
fixture.parent.mkdir(parents=True, exist_ok=True)
fixture.write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n')
print('Verified', len(cases), 'original KRKR2 log cases:', fixture)
