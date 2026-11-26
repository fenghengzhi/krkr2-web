export const videoSegmentSource = String.raw`
function segmentRange(movie){return [movie.segmentLoopStartFrame,movie.segmentLoopEndFrame].join(",");}
function segmentChecks(movie){
 var log=[segmentRange(movie)];
 movie.setSegmentLoop(-9,2147483647);log.add(segmentRange(movie));
 movie.setSegmentLoop(13,3);log.add(segmentRange(movie));
 movie.setSegmentLoop(6,6);log.add(segmentRange(movie));
 movie.setSegmentLoop(4294967298,4294967295);log.add(segmentRange(movie));
 var wide=4294967296*4194304;movie.setSegmentLoop(wide+5,-wide-7);log.add(segmentRange(movie));
 movie.setSegmentLoop(void,void);log.add(segmentRange(movie));
 movie.setSegmentLoop(-3.75,0,%[]);log.add(segmentRange(movie));
 try{movie.setSegmentLoop();log.add("accepted");}catch(e){log.add("missing-both");}
 try{movie.setSegmentLoop(5);log.add("accepted");}catch(e){log.add("missing-end");}
 try{movie.setSegmentLoop(5,%[]);log.add("accepted");}catch(e){log.add("conversion");}
 log.add(segmentRange(movie));movie.cancelSegmentLoop();log.add(segmentRange(movie));
 return log.join("|");
}`
export const expectedVideoSegments = '-1,-1|-9,2147483647|13,3|6,6|2,-1|5,-7|0,0|-3,0|missing-both|missing-end|conversion|-3,0|-1,-1'
