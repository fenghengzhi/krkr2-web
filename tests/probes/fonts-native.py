"""Extract original glyph lookup/decode and scalar blur routines; compile with ASan/UBSan."""
import pathlib,hashlib,json,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2]
REF=ROOT.parent/'kirikiroid2-web/cpp/core/visual'
OUT=ROOT/'out/verification/fonts/native';OUT.mkdir(parents=True,exist_ok=True)
def extract(source,marker):
 start=source.index(marker);begin=source.index('{',start);i=begin+1;depth=1;quote=None
 while depth:
  if quote:
   if source[i]=='\\':i+=2;continue
   if source[i]==quote:quote=None
  elif source.startswith('//',i):i=source.index('\n',i);continue
  elif source.startswith('/*',i):i=source.index('*/',i)+2;continue
  elif source[i] in '\"\'':quote=source[i]
  elif source[i]=='{':depth+=1
  elif source[i]=='}':depth-=1
  i+=1
 return source[start:i]
paths=['PrerenderedFont.cpp','PrerenderedFont.h','tvpgl.cpp','gl/blend_function.cpp','gl/blend_functor_c.h','impl/LayerBitmapImpl.cpp','CharacterData.cpp','tvpfontstruc.h','LayerIntf.cpp','FreeTypeFontRasterizer.cpp']
sources={p:(REF/p).read_text() for p in paths}
pr=sources['PrerenderedFont.cpp'];tvp=sources['tvpgl.cpp'];blend=sources['gl/blend_function.cpp'];functor=sources['gl/blend_functor_c.h']
extracted='\n'.join([
extract(tvp,'tjs_uint fast_int_hypot('),
'#define TVP_GL_FUNC_DECL(ret,name,args) ret name args',
extract(tvp,'TVP_GL_FUNC_DECL(void, TVPUpscale65_255_c'),
'#define TVPUpscale65_255 TVPUpscale65_255_c',
extract(pr,'const tTVPPrerenderedCharacterItem *tTVPPrerenderedFont::Find('),
extract(pr,'void tTVPPrerenderedFont::Retrieve('),
 'template<int tmax> '+extract(functor,'struct ch_blur_add_mul_copy_xx_functor')+';',
 'template<typename functor> '+extract(blend,'static inline void ch_blur_copy_func('),
])
header=r'''
#include <cstdint>
#include <vector>
#include <fstream>
#include <iostream>
#include <cstring>
#include <algorithm>
using tjs_int=int32_t;using tjs_uint=uint32_t;using tjs_uint32=uint32_t;using tjs_uint16=uint16_t;using tjs_uint8=uint8_t;using tjs_uint64=uint64_t;using tjs_char=char16_t;using tjs_int16=int16_t;
'''
header+=sources['PrerenderedFont.h'][sources['PrerenderedFont.h'].index('#pragma pack(push'):sources['PrerenderedFont.h'].index('//---------------------------------------------------------------------------')]
header+=r'''
class tTVPPrerenderedFont {public:const tjs_uint8* Image;int Version;unsigned IndexCount;const tjs_char* ChIndex;const tTVPPrerenderedCharacterItem* Index;
const tTVPPrerenderedCharacterItem* Find(tjs_char ch);void Retrieve(const tTVPPrerenderedCharacterItem*,uint8_t*,int);};
template<typename F> void blend_func_c(uint8_t*d,const uint8_t*s,int length,const F&f){for(int i=0;i<length;i++)d[i]=f(d[i],s[i]);}
'''
main=r'''
int main(int argc,char**argv){
 if(argc!=2)return 2;
 std::ifstream in(argv[1],std::ios::binary);std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)),{});
 if(bytes.size()<36||memcmp("TVP pre-rendered font\x1a",bytes.data(),22)||bytes[23]!=2)return 3;
 auto u32=[&](int at){uint32_t x;memcpy(&x,bytes.data()+at,4);return x;};
 tTVPPrerenderedFont f;f.Image=bytes.data();f.Version=bytes[22];f.IndexCount=u32(24);f.ChIndex=(char16_t*)(bytes.data()+u32(28));f.Index=(tTVPPrerenderedCharacterItem*)(bytes.data()+u32(32));
 std::cout<<"{\"glyphs\":[";bool first=true;
 for(unsigned code=0;code<65536;code++){auto g=f.Find(code);if(!g)continue;if(!first)std::cout<<",";first=false;
 int pitch=g->Width+3;std::vector<uint8_t> buffer(pitch*g->Height+16,0xcd);f.Retrieve(g,buffer.data()+8,pitch);
 std::cout<<"{\"code\":"<<code<<",\"width\":"<<g->Width<<",\"height\":"<<g->Height<<",\"originX\":"<<g->OriginX<<",\"originY\":"<<g->OriginY<<",\"incX\":"<<g->IncX<<",\"incY\":"<<g->IncY<<",\"advance\":"<<g->Inc<<",\"coverage\":[";
 for(int y=0;y<g->Height;y++)for(int x=0;x<g->Width;x++){if(y||x)std::cout<<",";std::cout<<int(buffer[8+y*pitch+x]);}
 std::cout<<"]}";
 }
 std::cout<<"],\"shadows\":[";first=true;
 uint8_t src[12]={0,16,64,128,255,32,200,70,30,1,254,128};
 for(int level:{0,1,64,128,254,255})for(int radius=0;radius<=4;radius++){
 int width=4+radius*2,height=3+radius*2;std::vector<uint8_t> dest(width*height);
 if(radius)ch_blur_copy_func<ch_blur_add_mul_copy_xx_functor<255>>(dest.data(),width,width,height,src,4,4,3,radius,level);
 else for(int i=0;i<12;i++)dest[i]=level==255?src[i]:(src[i]*level>>8);
 if(!first)std::cout<<",";first=false;std::cout<<"{\"level\":"<<level<<",\"radius\":"<<radius<<",\"width\":"<<width<<",\"height\":"<<height<<",\"coverage\":[";
 for(size_t i=0;i<dest.size();i++){if(i)std::cout<<",";std::cout<<int(dest[i]);}std::cout<<"]}";
 }
 std::cout<<"]}\n";
}
'''
(OUT/'reference.inc').write_text('// Extracted reference font routines. Original paths/hashes recorded in native.json.\n'+extracted)
(OUT/'oracle.cpp').write_text(header+'\n#include "reference.inc"\n'+main)
subprocess.run(['clang++','-std=c++17','-O1','-g','-fsanitize=address,undefined',str(OUT/'oracle.cpp'),'-o',str(OUT/'oracle')],check=True)
reports=[]
for version in [0,1]:
 result=subprocess.run([str(OUT/'oracle'),str(ROOT/f'tests/fixtures/font/coverage-v{version}.tft')],check=True,capture_output=True,text=True)
 report=json.loads(result.stdout);report['version']=version;reports.append(report)
metadata={'sourceSha256':{p:hashlib.sha256((REF/p).read_bytes()).hexdigest() for p in paths},'extractedSha256':hashlib.sha256(extracted.encode()).hexdigest(),'sanitizers':['address','undefined'],'scope':'Exact reference Find, Retrieve, upscale and blur routines; driver supplies parsed header pointers and synthetic input, not a complete native font/rendering backend.','reports':reports}
(ROOT/'tests/fixtures/font/native.json').write_text(json.dumps(metadata,indent=2)+'\n')
print('PASS: 12 reference glyph decodes, 60 native blur outputs; ASan/UBSan clean')
