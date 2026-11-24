/** The same unchanged distribution and read-only observations are used by the
 * browser route and the hosted original-SDK initial-layout observation. */
export const kagIntroSource = {
  url: 'https://raw.githubusercontent.com/fenghengzhi/kirikiroid2-web/8b40dba4a18ec0a4429d6003d77eb8c3d3098821/tests/test_files/xp3/kag3_intro.xp3',
  bytes: 908364,
  sha256: 'b2efe3e6d871c8961c1e0e00070fd0e22a18cdb5cdbf8da4a3cb4e03b7abc46a',
} as const

export const kagIntroStateExpression = `(function(){
  if(typeof kag=="undefined" || typeof kag.current=="undefined" || typeof kag.mainConductor=="undefined")return "pending";
  var p=kag.fore.base.Anim_loadParams;
  return [kag.currentLabel,int(kag.clickWaiting),int(kag.lineBreak.visible),int(kag.pageBreak.visible),
    kag.conductor.curLine,kag.conductor.curPos,kag.conductor.status,kag.current.numLinks,
    string(f.bg),p===void?"":p.storage,kag.conductor.lastTagName].join("|");
})()`

export const kagIntroLayoutFields = [
  'fontFace', 'userFace', 'requestedNativeFace', 'nativeFontHeight', 'fontSize', 'pendingFontSize',
  'lineSize', 'lineSpacing', 'reservedLineSize', 'defaultLineSize', 'imageWidth', 'imageHeight',
  'displayWidth', 'displayHeight', 'marginLeft', 'marginTop', 'marginRight', 'marginBottom',
  'lineOriginX', 'lineOriginY', 'linePosition', 'lineBaseline', 'visible', 'frontMessage0', 'backMessage0',
  'lineWrapThreshold', 'characterPitch', 'penX', 'penY', 'ignoreCR', 'fontBold', 'fontItalic',
  'titleAdvanceAtCurrentHeight', 'firstLinkAdvanceAtCurrentHeight', 'secondLinkAdvanceAtCurrentHeight',
  'exitAdvanceAtCurrentHeight',
] as const

export const kagIntroLayoutExpression = `(function(){var m=kag.current;
  return [m.fontFace,m.userFace,m.lineLayer.font.face,m.lineLayer.font.height,m.fontSize,m._fontSize,
    m.lineSize,m.lineSpacing,m.reserveLineSize,m.defaultLineSize,m.imageWidth,m.imageHeight,m.width,m.height,
    m.marginL,m.marginT,m.marginR,m.marginB,m.lineLayerOriginX,m.lineLayerOriginY,m.lineLayerPos,m.lineLayerBase,
    int(m.visible),int(m===kag.fore.messages[0]),int(m===kag.back.messages[0]),
    m.relinexpos,m.pitch,m.x,m.y,int(kag.conductor.ignoreCR),int(m.lineLayer.font.bold),int(m.lineLayer.font.italic),
    m.lineLayer.font.getTextWidth("Introduction to Kirikiri and"),m.lineLayer.font.getTextWidth("What is Kirikiri?"),
    m.lineLayer.font.getTextWidth("What is KAG?"),m.lineLayer.font.getTextWidth("Exit")].join("|");
})()`

export const kagIntroFontMetricFields = [
  'height', 'bold', 'titleWhole', 'titleCodeUnits', 'firstLinkWhole', 'firstLinkCodeUnits',
  'secondLinkWhole', 'secondLinkCodeUnits', 'exitWhole', 'exitCodeUnits',
] as const

/** A separate never-shown child owns this temporary Font. Font(existingLayer)
 * would observe and mutate that existing Layer's native font state instead.
 * This runs once, only after preserving the game's unmodified wait/layout. */
export const kagIntroFontMetricExpression = `(function(){
  var layer=void,font=void,primary=void,cleanup=[],rows=[];
  try{
    layer=new Layer(kag,kag.current);layer.visible=false;font=new Font(layer);
    font.face=kag.current.lineLayer.font.face;font.italic=false;font.angle=0;
    var heights=[24,40],samples=["Introduction to Kirikiri and","What is Kirikiri?","What is KAG?","Exit"];
    for(var h=0;h<heights.count;h++)for(var b=0;b<2;b++){
      font.height=heights[h];font.bold=b;
      var row=[heights[h],b];
      for(var n=0;n<samples.count;n++){
        var text=samples[n],sum=0;
        for(var c=0;c<text.length;c++)sum+=font.getTextWidth(text.charAt(c));
        row.add(font.getTextWidth(text));row.add(sum);
      }
      rows.add(row.join(","));
    }
  }catch(e){primary=e;}
  try{if(font!==void && isvalid font)invalidate font;}catch(e){cleanup.add(e.message);}
  try{if(layer!==void && isvalid layer)invalidate layer;}catch(e){cleanup.add(e.message);}
  if(primary!==void){
    if(cleanup.count)throw new Exception(primary.message+" | Font probe cleanup: "+cleanup.join(" | "));
    throw primary;
  }
  if(cleanup.count)throw new Exception("Font probe cleanup: "+cleanup.join(" | "));
  return rows.join(";");
})()`
