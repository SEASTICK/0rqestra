export const MIN_ZOOM=.25;
export const MAX_ZOOM=3;
export function zoomAt(camera,point,nextZoom){
  const zoom=Math.min(MAX_ZOOM,Math.max(MIN_ZOOM,nextZoom));
  if(zoom===camera.zoom)return camera;
  return {zoom,x:point.x-(point.x-camera.x)*zoom/camera.zoom,y:point.y-(point.y-camera.y)*zoom/camera.zoom};
}
export function wheelCamera(camera,{deltaY,deltaMode=0,ctrlKey=false},point,height){
  const pixels=deltaY*(deltaMode===1?16:deltaMode===2?height:1);
  if(!Number.isFinite(pixels)||pixels===0)return camera;
  const delta=Math.max(-240,Math.min(240,pixels));
  return zoomAt(camera,point,camera.zoom*Math.exp(-delta*(ctrlKey ? .006 : .0018)));
}
