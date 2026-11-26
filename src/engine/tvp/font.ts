/** Font wrappers observe a Layer's native font state without retaining that Layer. */
export const fontMetricMethods = ['getTextWidth', 'getTextHeight', 'getEscWidthX', 'getEscWidthY', 'getEscHeightX', 'getEscHeightY'] as const
export const fontClass = (nativeFontMetrics = false): string => String.raw`
class Font {
  function Font(layer) { __host("Font.bind",this,layer); }
  function finalize() {}
  property __data { getter(){return __host("Font.state",this).fontData;} }
  function mapPrerenderedFont(args*) { if(args.count<1)throw new global.Exception("Missing storage for mapPrerenderedFont");__host("Font.map",__data,string(args[0]),this); }
  function unmapPrerenderedFont() { __host("Font.unmap",__data,void,this); }
  function getTextWidth(args*) { if(args.count<1)throw new global.Exception("Missing text for getTextWidth");return __host("Font.measure",string(args[0]),__data,this${nativeFontMetrics ? ',"getTextWidth"' : ''}).width; }
  function getTextHeight(args*) { if(args.count<1)throw new global.Exception("Missing text for getTextHeight");return __host("Font.measure",string(args[0]),__data,this${nativeFontMetrics ? ',"getTextHeight"' : ''}).height; }
  function getGlyphDrawRect(args*) { if(args.count<1)throw new Exception("Missing text for getGlyphDrawRect");var r=__host("Font.bounds",string(args[0]),__data);return new Rect(r.left,r.top,r.right,r.bottom); }
  function getEscWidthX(args*) { if(args.count<1)throw new global.Exception("Missing text for getEscWidthX");return ${nativeFontMetrics ? '__host("Font.measure",string(args[0]),__data,this,"getEscWidthX").width' : 'getTextWidth(args[0])'}*Math.cos(angle*Math.PI/1800); }
  function getEscWidthY(args*) { if(args.count<1)throw new global.Exception("Missing text for getEscWidthY");return -${nativeFontMetrics ? '__host("Font.measure",string(args[0]),__data,this,"getEscWidthY").width' : 'getTextWidth(args[0])'}*Math.sin(angle*Math.PI/1800); }
  function getEscHeightX(args*) { if(args.count<1)throw new global.Exception("Missing text for getEscHeightX");return ${nativeFontMetrics ? '__host("Font.measure",string(args[0]),__data,this,"getEscHeightX").height' : 'getTextHeight(args[0])'}*Math.sin(angle*Math.PI/1800); }
  function getEscHeightY(args*) { if(args.count<1)throw new global.Exception("Missing text for getEscHeightY");return ${nativeFontMetrics ? '__host("Font.measure",string(args[0]),__data,this,"getEscHeightY").height' : 'getTextHeight(args[0])'}*Math.cos(angle*Math.PI/1800); }
  function getList(args*) { if(args.count<1)throw new Exception("Missing flags for getList");return __host("Font.list",int(args[0])&0xffffffff,__data); }
  function doUserSelect(args*) {
    if(args.count<4)throw new Exception("Missing font selection arguments");
    var selected=__host("Font.select",int(args[0])&0xffffffff,string(args[1]),string(args[2]),string(args[3]),__data);
    if(selected===null)return false;
    __data.face=selected;__data.faceIsFileName=false;
    __host("Font.attention",this,__data,true);return true;
  }
  ${['height', 'face', 'bold', 'italic', 'underline', 'strikeout', 'angle', 'faceIsFileName']
    .map(
      (name) => `property ${name} {
    getter() { return __data.${name}; }
    setter(value) { __data.${name}=${name === 'face' ? 'string(value)' : name === 'height' ? 'Math.abs(int(value))' : name === 'angle' ? '((int(value)%3600)+3600)%3600' : 'int(!!value)'};__host("Font.attention",this,__data); }
  }`,
    )
    .join('\n')}
}
${nativeFontMetrics ? fontMetricMethods.map((name) =>
  `Font.${name}=__host("Font.metricMethod","${name}",Font.${name} incontextof null);`).join('\n') : ''}
`
