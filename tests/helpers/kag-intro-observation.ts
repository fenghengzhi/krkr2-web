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
] as const

export const kagIntroLayoutExpression = `(function(){var m=kag.current;
  return [m.fontFace,m.userFace,m.lineLayer.font.face,m.lineLayer.font.height,m.fontSize,m._fontSize,
    m.lineSize,m.lineSpacing,m.reserveLineSize,m.defaultLineSize,m.imageWidth,m.imageHeight,m.width,m.height,
    m.marginL,m.marginT,m.marginR,m.marginB,m.lineLayerOriginX,m.lineLayerOriginY,m.lineLayerPos,m.lineLayerBase,
    int(m.visible),int(m===kag.fore.messages[0]),int(m===kag.back.messages[0])].join("|");
})()`
