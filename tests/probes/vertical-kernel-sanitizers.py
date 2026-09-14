"""Stress the production C kernel with native ASan/UBSan, separate from reference vectors."""
import hashlib,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'out/verification/text-layout/native';OUT.mkdir(parents=True,exist_ok=True)
INCLUDE=ROOT.parent/'toolchains/krkr2/emsdk/upstream/emscripten/cache/ports/freetype/freetype-VER-2-14-3/include'
LIB=ROOT/'out/verification/font-geometry/freetype-build/libfreetype.a'
stub=OUT/'include/emscripten';stub.mkdir(parents=True,exist_ok=True)
(stub/'emscripten.h').write_text('#define EMSCRIPTEN_KEEPALIVE\n')
driver=r'''
#include <assert.h>
#include <math.h>
#include <stdio.h>
'''+ '#include '+json.dumps(str(ROOT/'native/fonts/font.c'))+r'''
int main(int argc,char**argv){
 assert(argc==2);FILE *f=fopen(argv[1],"rb");assert(f);fseek(f,0,SEEK_END);long size=ftell(f);rewind(f);
 unsigned char *source=malloc(size);assert(source);assert(fread(source,1,size,f)==size);fclose(f);
 int id=krfont_open(source,size,0);assert(id);free(source);assert(krfont_abi()==2);
 const int heights[]={7,13,20,37},angles[]={0,300,900,1800,2700,3599};int checks=0;
 for(int hi=0;hi<4;hi++)for(int index=0;index<11;index++)for(int flags=0;flags<32;flags++)for(int ai=0;ai<6;ai++)for(int upright=0;upright<2;upright++){
  int h=heights[hi],angle=angles[ai];const int32_t *p=krfont_metrics_index(id,h,flags,index);assert(p);
  int32_t m[12];memcpy(m,p,sizeof(m));int advance=(m[upright?5:4]+32)>>6;
  double rad=(upright?angle-2700:angle)*3.14159265358979323846/1800;
  int c=lround(cos(rad)*65536),s=lround(sin(rad)*65536),ox=upright?m[2]-m[0]-h*32:0,oy=upright?-m[3]-m[1]:-m[6]*64;
  int32_t cmd[15]={c,-s,s,c,ox,oy,0};
  for(int line=0;line<2;line++){
   int position=m[line?9:7];if(!(flags&(4<<line))||position<0||advance<=0)continue;
   int top=position-m[8]/2;if(top<0)top=0;int bottom=top+m[8],at=7+4*cmd[6]++;
   if(upright){cmd[at]=-bottom*64-ox;cmd[at+1]=-advance*64-oy;cmd[at+2]=-top*64-ox;cmd[at+3]=-oy;}
   else{cmd[at]=0;cmd[at+1]=(m[6]-bottom)*64;cmd[at+2]=advance*64;cmd[at+3]=(m[6]-top)*64;}
  }
  p=krfont_glyph_index(id,h,flags,index,cmd);assert(p && !krfont_error());
  assert(p[0]>=0&&p[1]>=0&&p[0]<=4096&&p[1]<=4096&&p[7]==p[0]*p[1]);
  if(flags&16)for(int i=0;i<p[7];i++)assert(pixels[i]==0||pixels[i]==255);
  p=krfont_bounds_index(id,h,flags,index,cmd);assert(p && !krfont_error());assert(p[0]<=p[2]&&p[1]<=p[3]);
  checks++;
 }
 int32_t invalid[15]={0};assert(!krfont_glyph_index(id,20,0,3,invalid)&&krfont_error()==-1);
 invalid[0]=invalid[3]=65536;invalid[6]=3;assert(!krfont_glyph_index(id,20,0,3,invalid)&&krfont_error()==-1);
 invalid[6]=0;assert(!krfont_glyph_index(id,20,0,65535,invalid)&&krfont_error()==-2);
 assert(krfont_glyph_index(id,20,0,3,invalid));
 krfont_close(id);krfont_close(id);krfont_done();krfont_done();
 printf("{\"checks\":%d,\"invalidInputs\":3,\"recovered\":true}\n",checks);
}
'''
(OUT/'kernel-sanitizers.c').write_text(driver)
command=['clang','-std=c11','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer',
 '-I'+str(OUT/'include'),'-I'+str(INCLUDE),str(OUT/'kernel-sanitizers.c'),str(LIB),'-lz','-lm','-o',str(OUT/'kernel-sanitizers')]
subprocess.run(command,check=True)
cases=[];stderr=''
for file in ['vert.ttf','novmetrics.ttf']:
 run=subprocess.run([str(OUT/'kernel-sanitizers'),str(ROOT/'tests/fixtures/text-layout'/file)],check=True,capture_output=True,text=True)
 cases.append({'file':file,**json.loads(run.stdout)});stderr+=run.stderr
(OUT/'sanitizer-stderr.txt').write_text(stderr)
result={'checks':sum(case['checks'] for case in cases),'cases':cases,'sanitizers':['address','undefined'],
 'sourceSha256':hashlib.sha256((ROOT/'native/fonts/font.c').read_bytes()).hexdigest(),
 'driverSha256':hashlib.sha256((OUT/'kernel-sanitizers.c').read_bytes()).hexdigest(),
 'librarySha256':hashlib.sha256(LIB.read_bytes()).hexdigest(),
 'scope':'Production C kernel compiled for this native host with ASan/UBSan. Linked FreeType is independently built but not instrumented. This stress test is not an independent rendering oracle.'}
(OUT/'sanitizers.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
