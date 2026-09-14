"""Run the original Win32 enumeration callback with controlled metadata rows.

This does not enumerate this host's fonts or validate Web charset inference.
"""
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT.parent / 'kirikiroid2-web/cpp/core/visual/impl/TVPSysFont.cpp'
OUT = ROOT / 'out/verification/font-selection/native'
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
extracted = extract(source, 'struct tTVPFSEnumFontsProcData {') + ';\n' + extract(source, 'static int CALLBACK TVPFSFEnumFontsProc(')
(OUT / 'reference.inc').write_text(extracted)
# name, pitch bit (1 means proportional), charset, ntmFlags, FontType
rows = [
    ('Latin', 1, 0, 0, 4), ('Mono', 0, 128, 0, 4),
    ('@Mono', 0, 128, 0, 4), ('Symbols', 0, 2, 0, 4),
    ('Bitmap', 0, 0, 0, 1), ('PostScriptOpenType', 1, 0, 0x20000, 0),
    ('TrueTypeOpenType', 0, 128, 0x40000, 0), ('DefaultCharset', 1, 1, 0, 4),
    ('MultiCharset', 0, 2, 0, 4), ('MultiCharset', 0, 128, 0, 4),
    ('DuplicateAfterFilter', 1, 0, 0, 4), ('DuplicateAfterFilter', 0, 128, 0, 4),
    ('Latin', 1, 0, 0, 4), ('@Symbols', 0, 2, 0, 4),
]
header = '''
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using ttstr=std::string; using tjs_uint32=uint32_t; using BYTE=uint8_t; using LPARAM=intptr_t;
#define CALLBACK
constexpr int TVP_FSF_FIXEDPITCH=1,TVP_FSF_SAMECHARSET=2,TVP_FSF_NOVERTICAL=4,
 TVP_FSF_TRUETYPEONLY=8,TVP_FSF_IGNORESYMBOL=16,TMPF_FIXED_PITCH=1,SYMBOL_CHARSET=2,
 NTM_PS_OPENTYPE=0x20000,NTM_TT_OPENTYPE=0x40000,TRUETYPE_FONTTYPE=4;
struct LOGFONT {const char* lfFaceName;BYTE lfCharSet;};
struct ENUMLOGFONTEX {LOGFONT elfLogFont;};
struct NEWTEXTMETRIC {BYTE tmPitchAndFamily;uint32_t ntmFlags;};
struct NEWTEXTMETRICEX {NEWTEXTMETRIC ntmTm;};
'''
calls = '\n'.join('''{ENUMLOGFONTEX l{{%s,%d}};NEWTEXTMETRICEX m{{%d,%d}};
TVPFSFEnumFontsProc(&l,&m,%d,reinterpret_cast<LPARAM>(&data));}''' % (json.dumps(name), cs, pitch, ntm, kind) for name,pitch,cs,ntm,kind in rows)
body = '''
int main() {
 std::cout<<"[";bool first=true;
 for(int extra:{0,256})for(int flags=0;flags<32;flags++)for(int cs:{0,128,2,1}){
  std::vector<ttstr> result;tTVPFSEnumFontsProcData data(result,flags|extra,cs);
''' + calls + '''
  if(!first)std::cout<<",";first=false;
  std::cout<<"{\\"flags\\":"<<(flags|extra)<<",\\"charset\\":"<<cs<<",\\"names\\":[";
  for(size_t i=0;i<result.size();i++){if(i)std::cout<<",";std::cout<<"\\\""<<result[i]<<"\\\"";}
  std::cout<<"]}";
 }
 std::cout<<"]\\n";
}
'''
(OUT / 'oracle.cpp').write_text(header + '#include "reference.inc"\n' + body)
command = ['clang++', '-std=c++17', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', str(OUT / 'oracle.cpp'), '-o', str(OUT / 'oracle')]
subprocess.run(command, check=True)
result = subprocess.run([str(OUT / 'oracle')], check=True, text=True, capture_output=True)
(OUT / 'stderr.txt').write_text(result.stderr)
reference = {
    'scope': 'Original enumeration callback only, on synthetic Win32 metadata; not GDI enumeration or SFNT charset inference.',
    'source': str(SOURCE.relative_to(ROOT.parent)),
    'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'extractedSha256': hashlib.sha256(extracted.encode()).hexdigest(),
    'sanitizers': ['address', 'undefined'],
    'rows': [{'name': name, 'source': 'system', 'fixedPitch': not bool(pitch & 1), 'outline': bool(ntm & 0x60000 or kind & 4), 'charsets': [cs], 'vertical': name.startswith('@')} for name,pitch,cs,ntm,kind in rows],
    'cases': json.loads(result.stdout),
}
assert len(reference['cases']) == 256
path = ROOT / 'tests/fixtures/font-selection/filter-reference.json'
path.write_text(json.dumps(reference, indent=2) + '\n')
print('Generated 256 native filter cases:', path)
