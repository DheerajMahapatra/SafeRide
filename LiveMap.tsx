import React, { useRef, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { WebView } from "react-native-webview";

const green = "#22c55e";
const red = "#ef4444";

const LEAFLET_HTML = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#m{height:100%;margin:0;background:#0b111a}
.leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(1.1) contrast(1.1)}
.leaflet-control-attribution{font-size:8px;opacity:.6}
.leaflet-popup-content-wrapper,.leaflet-popup-tip{filter:none!important}
.zc{position:absolute;top:10px;right:10px;z-index:1000;display:flex;flex-direction:column;gap:2px}
.zc button{width:36px;height:36px;background:rgba(18,26,38,0.92);border:1px solid rgba(255,255,255,0.15);color:#f5f7fa;font-size:20px;font-weight:700;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.zc button:active{background:rgba(34,197,94,0.3)}
.ml{position:absolute;bottom:10px;right:10px;z-index:1000;width:36px;height:36px;background:rgba(18,26,38,0.92);border:1px solid rgba(255,255,255,0.15);color:#f5f7fa;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px}
.ml:active{background:rgba(34,197,94,0.3)}
.cm{width:18px;height:18px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 10px rgba(34,197,94,0.8)}
.sm{background:#22c55e;width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 6px rgba(34,197,94,0.6)}
.em{background:#ef4444;width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 6px rgba(239,68,68,0.6)}
.pulse{animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,0.4)}70%{box-shadow:0 0 0 15px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
</style>
</head><body><div id="m"></div>
<div class="zc"><button onclick="map.zoomIn()">+</button><button onclick="map.zoomOut()">−</button></div>
<button class="ml" onclick="goMyLoc()">⌖</button>
<script>
var map=L.map('m',{zoomControl:false}).setView([20.5937,78.9629],12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
var cm=null,line=null,si=null,ei=null,ui=false,it=null;
map.on('dragstart zoomstart',function(){ui=true;clearTimeout(it);});
map.on('dragend zoomend',function(){it=setTimeout(function(){ui=false;},3000);});
function goMyLoc(){if(cm){map.setView(cm.getLatLng(),16,{animate:true});}}
var sI=L.divIcon({className:'',html:'<div class="sm"></div>',iconSize:[14,14],iconAnchor:[7,7]});
var eI=L.divIcon({className:'',html:'<div class="em"></div>',iconSize:[14,14],iconAnchor:[7,7]});
function render(raw){try{var d=JSON.parse(raw);var pts=(d.points||[]).map(function(p){return[p.lat,p.lng];});
if(pts.length>1){if(line){line.setLatLngs(pts);}else{line=L.polyline(pts,{color:'#22c55e',weight:4,opacity:0.85,smoothFactor:1.5}).addTo(map);}}
function hDist(a,b){var R=6371e3;var p1=a[0]*Math.PI/180,p2=b[0]*Math.PI/180;var dp=(b[0]-a[0])*Math.PI/180;var dl=(b[1]-a[1])*Math.PI/180;var x=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
var spLatLng=d.sp&&d.sp.lat!=null?[d.sp.lat,d.sp.lng]:null;
var epLatLng=d.ep&&d.ep.lat!=null?[d.ep.lat,d.ep.lng]:null;
var pin=d.pins&&d.pins[0];var curLatLng=null;if(pin&&pin.lat!=null){curLatLng=[pin.lat,pin.lng];}
var mergeStartEnd=spLatLng&&epLatLng&&hDist(spLatLng,epLatLng)<50;
var mergeStartCur=spLatLng&&curLatLng&&hDist(spLatLng,curLatLng)<50;
var showStart=spLatLng&&!mergeStartEnd&&!mergeStartCur;
var showEnd=epLatLng&&!mergeStartEnd;
if(showStart){if(si){si.setLatLng(spLatLng);}else{si=L.marker(spLatLng,{icon:sI}).addTo(map);}}
if(showEnd){if(ei){ei.setLatLng(epLatLng);}else{ei=L.marker(epLatLng,{icon:eI}).addTo(map);}}
if(si&&!showStart){si.remove();si=null;}
if(ei&&!showEnd){ei.remove();ei=null;}
if(curLatLng){var mc=pin.color||'#22c55e';
if(cm){cm.setLatLng(curLatLng);cm.getElement().style.background=mc;}else{cm=L.marker(curLatLng,{icon:L.divIcon({className:'',html:'<div class="cm pulse" style="background:'+mc+'"></div>',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map);}
if(!ui){map.setView(curLatLng,16,{animate:true,duration:0.8});}}}catch(e){}}
document.addEventListener('message',function(e){render(e.data);});
window.addEventListener('message',function(e){render(e.data);});
</script></body></html>`;

export default function LiveMap({lat,lng,points=[],pins=[],startPt,endPt,height=220}:{
  lat?:number;lng?:number;points?:{lat:number;lng:number}[];
  pins?:{lat:number;lng:number;color:string}[];
  startPt?:{lat:number;lng:number};endPt?:{lat:number;lng:number};height?:number;
}) {
  const webRef = useRef<any>(null);
  const [mapReady, setMapReady] = useState(false);
  const hasFix = typeof lat === "number" && typeof lng === "number";
  const payload = useMemo(() => JSON.stringify({
    lat:lat??20.5937,lng:lng??78.9629,points:points.slice(-200),
    pins:pins.length?pins:hasFix?[{lat,lng,color:green}]:[],
    sp:startPt||(points.length>0?points[0]:null),ep:endPt||null,
  }),[lat,lng,points,pins,startPt,endPt,hasFix]);
  useEffect(()=>{if(webRef.current)webRef.current.postMessage(payload);},[payload]);
  return (
    <View style={{height,borderRadius:12,overflow:"hidden",backgroundColor:"#0b111a"}}>
      <WebView ref={webRef} source={{html:LEAFLET_HTML}} style={{flex:1,backgroundColor:"#0b111a"}}
        originWhitelist={["*"]} javaScriptEnabled domStorageEnabled scrollEnabled={false} cacheEnabled
        onLoadEnd={()=>{setMapReady(true);if(webRef.current)webRef.current.postMessage(payload);}} />
      {!mapReady&&<View pointerEvents="none" style={{position:"absolute",top:0,left:0,right:0,bottom:0,alignItems:"center",justifyContent:"center",backgroundColor:"#0b111a"}}>
        <ActivityIndicator size="small" color={green}/>
        <Text style={{color:"#f5f7fa",fontSize:10,fontWeight:"700",marginTop:6}}>Loading map…</Text>
      </View>}
      {mapReady&&!hasFix&&<View pointerEvents="none" style={{position:"absolute",top:10,left:10}}>
        <View style={[styles.pill,{backgroundColor:"rgba(0,0,0,0.6)",paddingVertical:3}]}>
          <Text style={{color:"#f5f7fa",fontSize:10,fontWeight:"700"}}>Waiting for location…</Text>
        </View>
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  pill:{backgroundColor:"rgba(255,255,255,0.06)",borderRadius:20,paddingHorizontal:12,paddingVertical:6,alignItems:"center",justifyContent:"center"},
});
