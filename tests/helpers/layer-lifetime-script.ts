/** Shared definitions executed through the real TVP bridge, as source or native bytecode. */
export const layerLifetimeScript = (extra = '') => String.raw`
var layerDeaths=0,layerWindowDeaths=0,failLayer=false,failLayerConstruct=false,layerCaught="";
class LifetimeLayerWindow extends Window {
  function LifetimeLayerWindow(){super.Window();caption="layer owner";}
  function finalize(){layerWindowDeaths++;}
}
class LifetimeLayer extends Layer {
  function LifetimeLayer(window,parent=null){
    super.Layer(window,parent);
    if(failLayerConstruct)throw new global.Exception("layer-constructor");
  }
  // Deliberately omit super.finalize(): native resources belong to invalidation.
  function finalize(){layerDeaths++;if(failLayer)throw new global.Exception("layer-finalizer");}
}
${extra}
`
