"""Compile extracted KRKR font functions against an independent native FreeType."""
import hashlib, json, os, pathlib, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[2]
REF = ROOT.parent / 'kirikiroid2-web/cpp/core/visual'
OUT = ROOT / 'out/verification/font-geometry/freetype-native'
OUT.mkdir(parents=True, exist_ok=True)
LIB = pathlib.Path(os.environ.get('KRKR_REFERENCE_FREETYPE', ROOT/'out/verification/font-geometry/freetype-build/libfreetype.a'))
INCLUDE = pathlib.Path(os.environ.get('KRKR_FREETYPE_INCLUDE', ROOT.parent/'toolchains/krkr2/emsdk/upstream/emscripten/cache/ports/freetype/freetype-VER-2-14-3/include'))
def extract(source, marker):
    start = source.index(marker); i = source.index('{',start)+1; depth=1; quote=None
    while depth:
        if quote:
            if source[i]=='\\': i+=2; continue
            if source[i]==quote: quote=None
        elif source.startswith('//',i): i=source.index('\n',i); continue
        elif source.startswith('/*',i): i=source.index('*/',i)+2; continue
        elif source[i] in '\"\'': quote=source[i]
        elif source[i]=='{': depth+=1
        elif source[i]=='}': depth-=1
        i+=1
    return source[start:i]
paths = ['FreeType.cpp','FreeType.h','CharacterData.cpp']
sources = {p:(REF/p).read_text() for p in paths}
methods = '\n'.join(extract(sources['FreeType.cpp'], marker) for marker in [
    'bool tFreeTypeFace::LoadGlyphSlotFromCharcode(',
    'bool tFreeTypeFace::GetGlyphMetricsFromCharcode(',
    'bool tFreeTypeFace::GetGlyphSizeFromCharcode(',
    'bool tFreeTypeFace::GetGlyphRectFromCharcode(',
    'tTVPCharacterData *tFreeTypeFace::GetGlyphFromCharcode(',
])
lines = extract(sources['CharacterData.cpp'], 'void tTVPCharacterData::AddHorizontalLine(')
constructor = extract(sources['CharacterData.cpp'], 'tTVPCharacterData::tTVPCharacterData(const tjs_uint8 *indata,')
inline = '\n'.join(extract(sources['FreeType.h'], marker) for marker in ['static inline tjs_int FT_PosToInt(', 'void GetUnderline(', 'void GetStrikeOut('])
header = r'''
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_SYNTHESIS_H
#include FT_BITMAP_H
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
using tjs_int=int32_t;using tjs_uint=uint32_t;using tjs_uint8=uint8_t;using tjs_int32=int32_t;using tjs_char=char16_t;
#define TJS_W(x) x
void TVPThrowExceptionMessage(const char*s){throw std::runtime_error(s);}
void* TJSAlignedAlloc(size_t n,int){auto*p=malloc(n);if(!p)throw std::bad_alloc();return p;}
void TJSAlignedDealloc(void*p){free(p);}
enum {TVP_TF_BOLD=1,TVP_TF_ITALIC=2,TVP_TF_UNDERLINE=4,TVP_TF_STRIKEOUT=8,TVP_FACE_OPTIONS_NO_ANTIALIASING=16,TVP_FACE_OPTIONS_NO_HINTING=32,TVP_FACE_OPTIONS_FORCE_AUTO_HINTING=64};
struct tGlyphMetrics{tjs_int CellIncX,CellIncY;};
struct tTVPRect{int left,top,right,bottom;tTVPRect(int l=0,int t=0,int r=0,int b=0):left(l),top(t),right(r),bottom(b){}};
struct tTVPCharacterData{
 bool Antialiased,Blured,FullColored;int RefCount,OriginX,OriginY,Gray,Pitch=0;uint32_t BlackBoxX,BlackBoxY;uint8_t*Data=nullptr;tGlyphMetrics Metrics;
 tTVPCharacterData(const uint8_t*,int,int,int,unsigned,unsigned,const tGlyphMetrics&,bool=false);
 ~tTVPCharacterData(){free(Data);}
 void AddHorizontalLine(tjs_int,tjs_int,tjs_uint8);
};
struct tFreeTypeFace{
 FT_Face FTFace;int Options;FT_ULong(*UnicodeToLocalChar)(tjs_char)=nullptr;
 bool LoadGlyphSlotFromCharcode(tjs_char);
 bool GetGlyphMetricsFromCharcode(tjs_char,tGlyphMetrics&);
 bool GetGlyphSizeFromCharcode(tjs_char,tGlyphMetrics&);
 bool GetGlyphRectFromCharcode(tTVPRect&,tjs_char,tjs_int&,tjs_int&);
 tTVPCharacterData*GetGlyphFromCharcode(tjs_char);
''' + inline + '\n};\n'
main = r'''
int main(int argc,char**argv){
 if(argc!=2)return 2;FT_Library lib;if(FT_Init_FreeType(&lib))return 3;
 int major,minor,patch;FT_Library_Version(lib,&major,&minor,&patch);
 FT_Face face;if(FT_New_Face(lib,argv[1],0,&face))return 4;
 tFreeTypeFace f{face,0};bool first=true;
 std::cout<<"{\"version\":["<<major<<","<<minor<<","<<patch<<"],\"cases\":[";
 for(int height:{7,13,20,37})for(int flags=0;flags<32;flags++)for(int code:{32,81,82,84}){
  FT_Set_Pixel_Sizes(face,0,height);f.Options=flags&~16;tTVPRect r;int ax,ay;tGlyphMetrics size;
  if(!f.GetGlyphRectFromCharcode(r,code,ax,ay)||!f.GetGlyphSizeFromCharcode(code,size))return 5;
  f.Options=flags;auto*g=f.GetGlyphFromCharcode(code);if(!g)return 6;
  if(!first)std::cout<<",";first=false;
  std::cout<<"{\"height\":"<<height<<",\"flags\":"<<flags<<",\"code\":"<<code<<",\"metrics\":["<<r.left<<","<<r.top<<","<<r.right<<","<<r.bottom<<","<<ax<<"],\"advance\":"<<size.CellIncX<<",\"glyph\":["<<g->BlackBoxX<<","<<g->BlackBoxY<<","<<g->OriginX<<","<<g->OriginY<<","<<g->Metrics.CellIncX<<"],\"coverage\":[";
  for(unsigned y=0;y<g->BlackBoxY;y++)for(unsigned x=0;x<g->BlackBoxX;x++){if(y||x)std::cout<<",";std::cout<<int(g->Data[y*g->Pitch+x]);}
  std::cout<<"]}";delete g;
 }
 std::cout<<"]}\n";FT_Done_Face(face);FT_Done_FreeType(lib);
}
'''
extracted = constructor+'\n'+lines+'\n'+methods
(OUT/'reference.inc').write_text('// Copyright W.Dee and contributors. Extracted reference font routines.\n'+extracted)
(OUT/'oracle.cpp').write_text(header+'\n#include "reference.inc"\n'+main)
link = OUT/'libfreetype.6.dylib'
if not link.exists(): link.symlink_to(LIB)
subprocess.run(['clang++','-std=c++17','-O1','-g','-fsanitize=address,undefined','-I'+str(INCLUDE),str(OUT/'oracle.cpp'),str(LIB),'-lz','-Wl,-rpath,'+str(OUT),'-o',str(OUT/'oracle')],check=True)
font=ROOT/'tests/fixtures/font-geometry/outlines.ttf'
result=subprocess.run([str(OUT/'oracle'),str(font)],capture_output=True,text=True)
(OUT/'stderr.txt').write_text(result.stderr)
result.check_returncode()
report={'sourceSha256':{p:hashlib.sha256((REF/p).read_bytes()).hexdigest() for p in paths},'extractedSha256':hashlib.sha256((inline+extracted).encode()).hexdigest(),'librarySha256':hashlib.sha256(LIB.read_bytes()).hexdigest(),'fontSha256':hashlib.sha256(font.read_bytes()).hexdigest(),'sanitizers':['address','undefined'],'scope':'Extracted KRKR glyph metrics, style, bitmap conversion, constructor and decoration functions. Independent native FreeType binary; sanitizer instrumentation covers the reference driver, not that prebuilt library. Synthetic Unicode outline font only; no complete engine/GDI/font collection claim.',**json.loads(result.stdout)}
(ROOT/'tests/fixtures/font-geometry/freetype.json').write_text(json.dumps(report,separators=(',',':'))+'\n')
print('PASS',len(report['cases']),'reference font cases; native FreeType',report['version'],'; reference driver ASan/UBSan clean')
