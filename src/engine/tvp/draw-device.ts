/** The public nested class is a built-in drawing device; its opaque interface
 * is checked against its actual script identity by the host, never a pointer. */
export const drawDeviceClass = String.raw`
class PassThroughDrawDevice {
  var __drawDeviceId;
  function PassThroughDrawDevice(){__drawDeviceId=__host("DrawDevice.create",this);}
  function finalize(){}
  function recreate(){__host("DrawDevice.recreate",__drawDeviceId);}
  property interface {getter(){return __host("DrawDevice.interface",__drawDeviceId);}}
  property preferredDrawer {
    getter(){return __host("DrawDevice.preferred",__drawDeviceId);}
    setter(value){__host("DrawDevice.prefer",__drawDeviceId,int(value));}
  }
  property drawer {getter(){return __host("DrawDevice.drawer",__drawDeviceId);}}
  property dtNone {getter(){return 0;}}
  property dtDrawDib {getter(){return 1;}}
  property dtDBGDI {getter(){return 2;}}
  property dtDBDD {getter(){return 3;}}
  property dtDBD3D {getter(){return 4;}}
}
Window.PassThroughDrawDevice=PassThroughDrawDevice;
delete global.PassThroughDrawDevice;
`
