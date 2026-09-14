/** Script-owned geometry has no host resources or native pointer lifetime. */
export const rectClass = `
function __rectInt(value) {
  var n=int(value)&0xffffffff;
  return n>=0x80000000?n-0x100000000:n;
}
function __rectCheck(value) {
  if(!(value instanceof "Rect")) throw new Exception("Expected a Rect");
  return value.__rectValues;
}
function __rectArgs(args,count) {
  if(args.count<count) throw new Exception("Missing Rect arguments");
}
class Rect {
  var __rectValues;
  function Rect(args*) {
    __rectValues=[0,0,0,0];
    if(args.count==1) {
      var source=__rectCheck(args[0]);
      __rectValues=[source[0],source[1],source[2],source[3]];
    } else if(args.count==4) set(args*);
  }
  function isEmpty() {
    var v=__rectCheck(this);return int(v[0]>=v[2]||v[1]>=v[3]);
  }
  function clear() { __rectCheck(this);__rectValues=[0,0,0,0]; }
  function set(args*) {
    __rectCheck(this);__rectArgs(args,4);
    var v=[];for(var i=0;i<4;i++)v.add(__rectInt(args[i]));
    __rectValues=v;
  }
  function setSize(args*) {
    var v=__rectCheck(this);__rectArgs(args,2);
    var w=__rectInt(args[0]),h=__rectInt(args[1]);
    v[2]=__rectInt(v[0]+w);v[3]=__rectInt(v[1]+h);
  }
  function setOffset(args*) {
    var v=__rectCheck(this);__rectArgs(args,2);
    var x=__rectInt(args[0]),y=__rectInt(args[1]),w=__rectInt(v[2]-v[0]),h=__rectInt(v[3]-v[1]);
    __rectValues=[x,y,__rectInt(x+w),__rectInt(y+h)];
  }
  function addOffset(args*) {
    var v=__rectCheck(this);__rectArgs(args,2);
    var x=__rectInt(args[0]),y=__rectInt(args[1]);
    __rectValues=[__rectInt(v[0]+x),__rectInt(v[1]+y),__rectInt(v[2]+x),__rectInt(v[3]+y)];
  }
  function clip(args*) {
    var v=__rectCheck(this);__rectArgs(args,1);if(args[0]===null)return;
    var b=__rectCheck(args[0]),l=Math.max(v[0],b[0]),t=Math.max(v[1],b[1]),r=Math.min(v[2],b[2]),d=Math.min(v[3],b[3]);
    if(r<=l||d<=t)return 0;
    __rectValues=[__rectInt(l),__rectInt(t),__rectInt(r),__rectInt(d)];return 1;
  }
  function union(args*) {
    var v=__rectCheck(this);__rectArgs(args,1);if(args[0]===null)return;
    var b=__rectCheck(args[0]),l=Math.min(v[0],b[0]),t=Math.min(v[1],b[1]),r=Math.max(v[2],b[2]),d=Math.max(v[3],b[3]);
    if(r<=l||d<=t)return 0;
    __rectValues=[__rectInt(l),__rectInt(t),__rectInt(r),__rectInt(d)];return 1;
  }
  function intersects(args*) {
    var v=__rectCheck(this);__rectArgs(args,1);if(args[0]===null)return;
    var b=__rectCheck(args[0]);
    return int(v[0]<v[2]&&v[1]<v[3]&&b[0]<b[2]&&b[1]<b[3]&&v[0]<b[2]&&v[1]<b[3]&&v[2]>b[0]&&v[3]>b[1]);
  }
  function included(args*) {
    var v=__rectCheck(this);__rectArgs(args,1);if(args[0]===null)return;
    var b=__rectCheck(args[0]);
    return int(v[0]<v[2]&&v[1]<v[3]&&b[0]<b[2]&&b[1]<b[3]&&b[0]<=v[0]&&b[1]<=v[1]&&b[2]>=v[2]&&b[3]>=v[3]);
  }
  function includedPos(args*) {
    var v=__rectCheck(this);__rectArgs(args,2);
    var x=__rectInt(args[0]),y=__rectInt(args[1]);
    return int(x>=v[0]&&x<v[2]&&y>=v[1]&&y<v[3]);
  }
  function equal(args*) {
    var v=__rectCheck(this);__rectArgs(args,1);if(args[0]===null)return;
    var b=__rectCheck(args[0]);return int(v[0]==b[0]&&v[1]==b[1]&&v[2]==b[2]&&v[3]==b[3]);
  }
  ${['left', 'top', 'right', 'bottom']
    .map(
      (name, i) => `property ${name} {
    getter(){return __rectCheck(this)[${i}];}
    setter(value){__rectCheck(this)[${i}]=__rectInt(value);}
  }`,
    )
    .join('\n')}
  property width {
    getter(){var v=__rectCheck(this);return __rectInt(v[2]-v[0]);}
    setter(value){var v=__rectCheck(this);v[2]=__rectInt(v[0]+__rectInt(value));}
  }
  property height {
    getter(){var v=__rectCheck(this);return __rectInt(v[3]-v[1]);}
    setter(value){var v=__rectCheck(this);v[3]=__rectInt(v[1]+__rectInt(value));}
  }
  property nativeArray {
    getter(){throw new Exception("Rect.nativeArray requires a native plugin pointer ABI");}
  }
}
`
