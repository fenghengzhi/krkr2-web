// The Windows SDK and hosted Web player execute this same script. In the
// no-copy case write the replacement pixel before observing it: the original
// allocator does not specify its initial contents.
export const sharedImageCases = [
  { id: 'shared-main-province', expected: '34/90/91|85/7/11|34/90/11' },
  { id: 'shared-independ', expected: '34/90/11|85/7/53|34/90/11' },
  { id: 'shared-reassign', expected: '0,2,1|34/90/23|34/90/23|34/90/11' },
] as const

export const sharedImageSource = String.raw`
function sharedImageRun(kind){
 var win=new Window(),root=new Layer(win,null),a=new Layer(win,root),b=new Layer(win,root),c=new Layer(win,root);
 win.add(root);win.add(a);win.add(b);win.add(c);
 var result,failure;
 try{
  a.setImageSize(2,1);a.setMainPixel(0,0,34);a.setMaskPixel(0,0,90);a.setProvincePixel(0,0,11);
  b.assignImages(a);c.assignImages(b);
  if(kind=="shared-reassign"){
   a.setProvincePixel(0,0,23);b.imageModified=false;b.setClip(1,0,1,1);b.assignImages(a);
   result=b.clipLeft+","+b.clipWidth+","+int(b.imageModified)+"|";
  }else{
   if(kind=="shared-independ"){b.independMainImage(true);b.independProvinceImage(false);b.setProvincePixel(0,0,53);}
   else a.setProvincePixel(0,0,91);
   b.setMainPixel(0,0,85);b.setMaskPixel(0,0,7);result="";
  }
  var values=[],planes=[a,b,c];
  for(var i=0;i<3;i++){
   var layer=planes[i];values.add(layer.getMainPixel(0,0)+"/"+layer.getMaskPixel(0,0)+"/"+layer.getProvincePixel(0,0));
  }
  result+=values.join("|");
 }catch(e){failure=e;}
 invalidate win;if(failure!==void)throw failure;return result;
}
`
