/** Font wrappers observe a Layer's native font state without retaining that Layer. */
export const fontClass = String.raw`
class Font {
  function Font(layer) { __host("Font.bind",this,layer); }
  function finalize() {}
  property __data { getter(){return __host("Font.state",this).fontData;} }
  function mapPrerenderedFont(storage) { __host("Font.map",__data,string(storage)); }
  function unmapPrerenderedFont() { __host("Font.unmap",__data); }
  function getTextWidth(text) { return __host("Font.measure",string(text),__data).width; }
  function getTextHeight(text) { return __host("Font.measure",string(text),__data).height; }
  function getGlyphDrawRect(args*) { if(args.count<1)throw new Exception("Missing text for getGlyphDrawRect");var r=__host("Font.bounds",string(args[0]),__data);return new Rect(r.left,r.top,r.right,r.bottom); }
  function getEscWidthX(text) { return getTextWidth(text)*Math.cos(angle*Math.PI/1800); }
  function getEscWidthY(text) { return -getTextWidth(text)*Math.sin(angle*Math.PI/1800); }
  function getEscHeightX(text) { return getTextHeight(text)*Math.sin(angle*Math.PI/1800); }
  function getEscHeightY(text) { return getTextHeight(text)*Math.cos(angle*Math.PI/1800); }
  function getList(args*) { if(args.count<1)throw new Exception("Missing flags for getList");return __host("Font.list",int(args[0])&0xffffffff,__data); }
  function doUserSelect(args*) {
    if(args.count<4)throw new Exception("Missing font selection arguments");
    var selected=__host("Font.select",int(args[0])&0xffffffff,string(args[1]),string(args[2]),string(args[3]),__data);
    if(selected===null)return false;
    __data.face=selected;__data.faceIsFileName=false;return true;
  }
  ${['height', 'face', 'bold', 'italic', 'underline', 'strikeout', 'angle', 'faceIsFileName']
    .map(
      (name) => `property ${name} {
    getter() { return __data.${name}; }
    setter(value) { __data.${name}=${name === 'face' ? 'string(value)' : name === 'height' ? 'Math.abs(int(value))' : name === 'angle' ? '((int(value)%3600)+3600)%3600' : 'int(!!value)'}; }
  }`,
    )
    .join('\n')}
}
`
