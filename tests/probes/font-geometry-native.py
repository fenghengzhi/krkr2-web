"""Extract original rectangle and font-coordinate routines for independent vectors."""
import hashlib, json, pathlib, random, subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
REF = ROOT.parent / 'kirikiroid2-web/cpp/core/visual'
OUT = ROOT / 'out/verification/font-geometry/native'
FIXTURE = ROOT / 'tests/fixtures/font-geometry'
OUT.mkdir(parents=True, exist_ok=True)
FIXTURE.mkdir(parents=True, exist_ok=True)

def extract(source, marker):
    start = source.index(marker)
    i = source.index('{', start) + 1
    depth, quote = 1, None
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
    return source[start:i]

paths = ['ComplexRect.h', 'ComplexRect.cpp', 'RectItf.cpp', 'RectItf.h',
         'impl/LayerBitmapImpl.cpp', 'FreeTypeFontRasterizer.cpp']
sources = {p: (REF / p).read_text() for p in paths}
rect = sources['ComplexRect.h']
bitmap = sources['impl/LayerBitmapImpl.cpp']
start = bitmap.index('RadianAngle = Font.Angle * (M_PI / 1800);')
end = bitmap.index(';', bitmap.index('AscentOfsY =', start)) + 1
ascent = bitmap[start:end]
raster = sources['FreeTypeFontRasterizer.cpp']
start = raster.index('if(font.Font.Angle == 0)')
end = raster.index('\n\n    data->Antialiased', start)
advance = raster[start:end]
extracted = '\n'.join([
    'struct tTVPRect; bool TVPIntersectRect(tTVPRect*,const tTVPRect&,const tTVPRect&);',
    extract(rect, 'struct tTVPPoint {') + ';',
    extract(rect, 'struct tTVPPointD {') + ';',
    extract(rect, 'struct tTVPRect {') + ';',
    extract(sources['ComplexRect.cpp'], 'bool TVPIntersectRect('),
    extract(sources['ComplexRect.cpp'], 'bool TVPUnionRect('),
])
header = '''
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
using tjs_int=int32_t;
'''
body = '''
void coords(int angle,int h,int width) {
  struct FontData {int Angle;} Font{angle};
  double RadianAngle;int ascent=h,AscentOfsX,AscentOfsY;
''' + ascent + '''
  struct Glyph {struct {int CellIncX,CellIncY;} Metrics;} storage,*data=&storage;
  struct {FontData Font;} font{{angle}};int cx=width;
''' + advance + '''
  std::cout<<"["<<angle<<","<<h<<","<<width<<","<<AscentOfsX<<","<<AscentOfsY<<","<<data->Metrics.CellIncX<<","<<data->Metrics.CellIncY<<"]";
}
void emit(const tTVPRect &r) {std::cout<<r.left<<","<<r.top<<","<<r.right<<","<<r.bottom;}
int main(){
 std::cout<<"{\\"coordinates\\":[";bool first=true;
 for(int angle=0;angle<3600;angle++)for(int h:{0,6,8,16,31,64,255}) {
  if(!first)std::cout<<",";first=false;coords(angle,h,1+angle%37);
 }
 std::cout<<"],\\"rectangles\\":[";first=true;
 int l,t,r,b,L,T,R,B;
 while(std::cin>>l>>t>>r>>b>>L>>T>>R>>B){
  tTVPRect a(l,t,r,b),other(L,T,R,B),clip=a,united=a;
  bool c=clip.clip(other),u=TVPUnionRect(&united,united,other);
  if(!first)std::cout<<",";first=false;
  std::cout<<"{\\"a\\":[";emit(a);std::cout<<"],\\"b\\":[";emit(other);
  std::cout<<"],\\"clip\\":["<<c<<",";emit(clip);std::cout<<"],\\"union\\":["<<u<<",";emit(united);
  std::cout<<"],\\"relations\\":["<<a.is_empty()<<","<<other.is_empty()<<","<<a.intersects_with(other)<<","<<a.included_in(other)<<","<<other.included_in(a)<<","<<(a==other)<<"],\\"size\\":["<<a.get_width()<<","<<a.get_height()<<"]}";
 }
 std::cout<<"]}\\n";
}
'''
(OUT / 'reference.inc').write_text('// Copyright (C) 2000 W.Dee and contributors. Extracted reference geometry.\n' + extracted)
(OUT / 'oracle.cpp').write_text(header + '\n#include "reference.inc"\n' + body)
subprocess.run(['clang++', '-std=c++17', '-O1', '-g', '-fsanitize=address,undefined', str(OUT / 'oracle.cpp'), '-o', str(OUT / 'oracle')], check=True)
edges = [[0,0,0,0],[0,0,10,10],[10,10,20,20],[2,3,8,9],[-5,-6,-1,-2],[4,4,2,2],[-2,-2,-4,-4],[0,0,0,10],[0,0,10,0]]
pairs = [(a,b) for a in edges for b in edges]
rng = random.Random(7219)
pairs += [([rng.randrange(-10000,10001) for _ in range(4)], [rng.randrange(-10000,10001) for _ in range(4)]) for _ in range(256)]
input = '\n'.join(' '.join(map(str,a+b)) for a,b in pairs)+'\n'
(OUT / 'input.txt').write_text(input)
result = subprocess.run([str(OUT / 'oracle')], input=input, capture_output=True, text=True, check=True)
vectors = json.loads(result.stdout)
report = {'sourceSha256':{p:hashlib.sha256((REF/p).read_bytes()).hexdigest() for p in paths},
          'extractedSha256':hashlib.sha256((extracted+ascent+advance).encode()).hexdigest(),
          'sanitizers':['address','undefined'],
          'scope':'Exact reference rectangle kernels and font coordinate blocks with supplied integers. No signed-overflow cases, native TJS dispatch, OS font rasterization or full graphics pipeline claim.', **vectors}
(FIXTURE / 'reference.json').write_text(json.dumps(report,separators=(',',':'))+'\n')
print('PASS',len(vectors['rectangles']),'rectangle pairs and',len(vectors['coordinates']),'font coordinates; ASan/UBSan clean')
