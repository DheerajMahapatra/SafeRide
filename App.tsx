import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, TextInput, Alert, Platform, Modal, AppState, LogBox } from "react-native";

LogBox.ignoreLogs(["Text strings must be rendered within a <Text> component."]);
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Feather } from "@expo/vector-icons";

import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import * as NetInfo from "@react-native-community/netinfo";
import { supabase } from "./supabase";
import { CONFIG } from "./config";
import { startBackgroundLocation, stopBackgroundLocation, readBackgroundData, BACKGROUND_LOCATION_TASK } from "./tasks";
import { getGuardianTokens, sendExpoPush, notifyGuardiansTrackingStarted, notifyGuardiansTrackingStopped } from "./notifications";
import { signUp, signIn, signOut as authSignOut, getCurrentUser, AuthUser, updatePushToken } from "./auth";
import LiveMap from "./LiveMap";
import Constants from "expo-constants";

const isExpoGo = Constants.appOwnership === "expo";

async function registerBackgroundTasks(){
  if(typeof TaskManager.isTaskRegisteredAsync!=="function")return;
  try{
    const locReg = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
    if(!locReg){console.log("[SafeRide] Background tasks will register on first tracking start");}
  }catch(e){}
}

const bg = "#05080d";
const cardBg = "#121a26";
const cardBg2 = "#0f1620";
const border = "rgba(255,255,255,0.08)";
const green = "#22c55e";
const greenBright = "#3ddc84";
const red = "#ef4444";
const redBright = "#f75c5c";
const muted = "#6b7a8f";
const white = "#f5f7fa";
const blue = "#3b82f6";
const SPEED_LIMIT = CONFIG.SPEED_LIMIT;
const SAFE_BUFFER_KMH = CONFIG.SAFE_BUFFER_KMH;
const MIN_MOVING_KMH = CONFIG.MIN_MOVING_KMH;

function haversineKm(lat1:number,lon1:number,lat2:number,lon2:number):number{
  const R=6371;const dLat=((lat2-lat1)*Math.PI)/180;const dLon=((lon2-lon1)*Math.PI)/180;
  const a=Math.sin(dLat/2)**2+Math.cos((lat1*Math.PI)/180)*Math.cos((lat2*Math.PI)/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function computeRouteDistanceKm(points:{lat:number;lng:number}[]){let d=0;for(let i=1;i<points.length;i++){d+=haversineKm(points[i-1].lat,points[i-1].lng,points[i].lat,points[i].lng);}return d;}
function mondayOf(d:Date){const date=new Date(d);const day=date.getDay();const diff=(day===0?-6:1)-day;date.setDate(date.getDate()+diff);date.setHours(0,0,0,0);return date;}
function fmtHM(mins:number){const h=Math.floor(mins/60);const m=Math.round(mins%60);return h>0?`${h}h ${m}m`:`${m}m`;}
function fmtDuration(totalSec:number){const h=Math.floor(totalSec/3600);const m=Math.floor((totalSec%3600)/60);const s=Math.round(totalSec%60);if(h>0)return`${h}h ${m}m ${s}s`;if(m>0)return`${m}m ${s}s`;return`${s}s`;}
function fmtDate(ds:string){const d=new Date(ds);const t=new Date();const y=new Date(t);y.setDate(y.getDate()-1);
  if(d.toDateString()===t.toDateString())return "Today";if(d.toDateString()===y.toDateString())return "Yesterday";
  return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});}
function fmtTime(ts:number){return new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});}
function getRelativeTime(ts:number){const d=Date.now()-ts;if(d<60000)return "Just now";if(d<3600000)return `${Math.floor(d/60000)}m ago`;if(d<86400000)return `${Math.floor(d/3600000)}h ago`;return `${Math.floor(d/86400000)}d ago`;}

type LatLng={lat:number;lng:number};
type TripPoint={lat:number;lng:number;speed:number;timestamp:number};
type Trip={id:string;date:string;points:TripPoint[];distanceKm:number;durationSec:number;maxSpeed:number;avgSpeed:number;alertsCount:number;startedAt:number;endedAt:number;trackingStatus:string;startLocation:string;endLocation:string};
type AlertRecord={id:string;type:"alert"|"normal";speed:number;location:string;timestamp:number;lat?:number;lng?:number};
type WeeklyReport={weekStart:string;weekEnd:string;totalDistance:number;totalTime:number;totalTrips:number;maxSpeed:number;safetyScore:number;dailyMaxSpeeds:number[];dailyOverEvents:number[]};

// ---------- Send Push Helper ----------
async function pushToGuardians(driverId:string,title:string,body:string,data?:any){
  const tokens=await getGuardianTokens(driverId);
  if(tokens.length===0)return;
  await sendExpoPush(tokens,title,body,data);
}


function Pill({children,style}:any){return <View style={[styles.pill,style]}>{typeof children==="string"||typeof children==="number"?<Text>{children}</Text>:children}</View>;}
function BottomNav({tabs,active,onChange}:any){
  return (<View style={styles.bottomNav}>{tabs.map(({id,label,icon}:any)=>{const isActive=active===id;return(
    <Pressable key={id} onPress={()=>onChange(id)} style={[styles.navItem,isActive&&{borderColor:green,borderWidth:1}]}>
      <Feather name={icon as any} size={20} color={isActive?green:muted}/>
      <Text style={{fontSize:11,fontWeight:"700",color:isActive?green:muted,marginTop:2}}>{label}</Text>
    </Pressable>);})}</View>);
}

function WatchedDriverCard({driver}:{driver:any}){
  const loc=driver?.latest_location||null;const over=driver?.status==="OVERSPEED";
  const updatedAtMs=driver?.updated_at?new Date(driver.updated_at).getTime():0;
  const stale=!loc||Date.now()-updatedAtMs>25000;
  const pts:any[]=Array.isArray(driver?.route_points)?driver.route_points:[];
  const distKm=(typeof loc?.distance==="number")?loc.distance:computeRouteDistanceKm(pts);
  const lastSeen=updatedAtMs?getRelativeTime(updatedAtMs):"—";
  const[driverLocName,setDriverLocName]=useState("Locating...");
  useEffect(()=>{
    if(!loc){setDriverLocName("No location");return;}
    let cancelled=false;
    (async()=>{
      try{
        const results=await Location.reverseGeocodeAsync({latitude:loc.lat,longitude:loc.lng});
        if(!cancelled&&results&&results.length>0){
          const r=results[0];
          setDriverLocName([r.street,r.district||r.city].filter(Boolean).join(", ")||"Unknown location");
        }
      }catch(e){}
    })();
    return()=>{cancelled=true;};
  },[loc?.lat,loc?.lng]);
  return(
    <View style={{paddingHorizontal:16,marginTop:2}}>
      <View style={[styles.card,{borderLeftWidth:4,borderLeftColor:stale?muted:over?red:green}]}>
        <View style={{flexDirection:"row",justifyContent:"space-between",alignItems:"center"}}>
          <View style={{flexDirection:"row",alignItems:"center",gap:8}}>
            {!stale&&<View style={{width:8,height:8,borderRadius:4,backgroundColor:green}}/>}
            <Text style={{color:white,fontWeight:"800",fontSize:15}}>{stale?"Signal lost":"LIVE"} · {driver?.name||"Driver"}</Text>
          </View>
          <View style={[styles.pill,{backgroundColor:stale?"rgba(107,122,143,0.18)":over?"rgba(239,68,68,0.18)":"rgba(34,197,94,0.18)",paddingVertical:3,paddingHorizontal:8}]}>
            <Text style={{color:stale?muted:over?redBright:green,fontSize:10,fontWeight:"700"}}>{stale?"OFFLINE":over?"OVERSPEED":"SAFE"}</Text>
          </View>
        </View>
        {!stale&&loc&&<View style={{flexDirection:"row",alignItems:"center",gap:6,marginTop:8}}>
          <Feather name="map-pin" size={12} color={muted}/>
          <Text style={{color:muted,fontSize:11,flex:1}} numberOfLines={1}>{driverLocName}</Text>
        </View>}
        <View style={{marginTop:10}}>
          {loc?<LiveMap lat={loc.lat} lng={loc.lng} points={pts} pins={[{lat:loc.lat,lng:loc.lng,color:over?red:green}]} height={210}/>:
          <View style={{height:210,borderRadius:12,backgroundColor:"#0b111a",alignItems:"center",justifyContent:"center"}}>
            <Feather name="radio" size={20} color={muted}/>
            <Text style={{color:muted,fontSize:12,marginTop:6,textAlign:"center"}}>Waiting for the driver to start sharing...</Text>
            <Text style={{color:muted,fontSize:11,textAlign:"center"}}>(driver must tap Start on their phone)</Text>
          </View>}
          {!stale&&loc&&<View style={{position:"absolute",top:20,left:20,flexDirection:"row",gap:8}}>
            <View style={[styles.pill,{backgroundColor:"rgba(34,197,94,0.85)",flexDirection:"row",gap:5,alignItems:"center",paddingVertical:3}]}>
              <View style={{width:6,height:6,borderRadius:3,backgroundColor:"#05300f"}}/>
              <Text style={{color:"#05300f",fontSize:11,fontWeight:"800"}}>LIVE</Text>
            </View>
            {over&&<View style={[styles.pill,{backgroundColor:"rgba(239,68,68,0.92)",paddingVertical:3}]}>
              <Text style={{color:white,fontSize:11,fontWeight:"800"}}>OVERSPEEDING</Text>
            </View>}
          </View>}
        </View>
        <View style={{flexDirection:"row",gap:10,marginTop:12}}>
          <View style={[styles.card,{flex:1.2,backgroundColor:cardBg2}]}>
            <Text style={styles.labelSm}>SPEED</Text>
            <View style={{flexDirection:"row",alignItems:"baseline",gap:4}}>
              <Text style={{fontSize:26,fontWeight:"800",color:stale?muted:over?redBright:greenBright}}>{Math.round(driver?.speed||0)}</Text>
              <Text style={{fontSize:11,color:muted,fontWeight:"600"}}>km/h</Text>
            </View>
          </View>
          <View style={[styles.card,{flex:1,backgroundColor:cardBg2}]}>
            <Text style={styles.labelSm}>TRIP DIST</Text>
            <Text style={{fontSize:22,fontWeight:"800",color:white,marginTop:4}}>{distKm.toFixed(1)}</Text>
            <Text style={{fontSize:10,color:muted,fontWeight:"700"}}>KM</Text>
          </View>
          <View style={[styles.card,{flex:1,backgroundColor:cardBg2}]}>
            <Text style={styles.labelSm}>UPDATED</Text>
            <Text style={{fontSize:13,fontWeight:"800",color:white,marginTop:8}}>{lastSeen}</Text>
          </View>
        </View>
        {!!loc&&stale&&<Text style={{color:muted,fontSize:11,marginTop:8}}>No update for a while — the driver may have stopped tracking or lost signal.</Text>}
      </View>
    </View>
  );
}

// ===== HOME SCREEN =====
function HomeScreen({tracking,driverName,onSignOut,onStartTracking,onStopTracking}:any){
  const{isTracking,speed,status,coords,route,distanceKm,durationSec}=tracking;
  const[locationName,setLocationName]=useState("Acquiring...");

  useEffect(()=>{
    if(!coords){return;}
    let cancelled=false;
    (async()=>{
      try{
        const results=await Location.reverseGeocodeAsync({latitude:coords.lat,longitude:coords.lng});
        if(!cancelled&&results&&results.length>0){
          const r=results[0];
          setLocationName([r.street,r.district||r.city].filter(Boolean).join(", ")||"Unknown location");
        }
      }catch(e){}
    })();
    return()=>{cancelled=true;};
  },[coords?.lat,coords?.lng]);

  return(<ScrollView style={{flex:1}} contentContainerStyle={{paddingBottom:10}}>
    <View style={styles.headerRow}>
      <View style={{flexDirection:"row",alignItems:"center",gap:10}}>
        <View style={styles.logoBox}><Text style={{fontWeight:"800",color:"#05300f",fontSize:13}}>SR</Text></View>
        <View>
          <Text style={{color:white,fontWeight:"700",fontSize:15}}>SafeRide</Text>
          <View style={{flexDirection:"row",alignItems:"center",gap:4,marginTop:1}}>
            <View style={{width:6,height:6,borderRadius:3,backgroundColor:isTracking?green:muted}}/>
            <Text style={{fontSize:10,fontWeight:"700",color:isTracking?green:muted}}>
              {isTracking?"TRACKING ON":"TRACKING OFF"}
            </Text>
          </View>
        </View>
      </View>
      <View style={{flexDirection:"row",gap:8}}>
        {!isTracking?
          <Pressable onPress={onStartTracking} style={[styles.pill,{backgroundColor:"rgba(34,197,94,0.85)",flexDirection:"row",gap:5,alignItems:"center"}]}>
            <Feather name="play" size={12} color="#05300f"/>
            <Text style={{color:"#05300f",fontSize:11,fontWeight:"700"}}>START</Text>
          </Pressable>
          :
          <Pressable onPress={onStopTracking} style={[styles.pill,{backgroundColor:"rgba(239,68,68,0.85)",flexDirection:"row",gap:5,alignItems:"center"}]}>
            <Feather name="square" size={12} color="#fff"/>
            <Text style={{color:"#fff",fontSize:11,fontWeight:"700"}}>STOP</Text>
          </Pressable>
        }
      </View>
    </View>
    <View style={{paddingHorizontal:16}}>
      <View style={{position:"relative",borderRadius:12,overflow:"hidden",height:320}}>
        {isTracking&&coords?<><LiveMap lat={coords.lat} lng={coords.lng} points={route} pins={[{lat:coords.lat,lng:coords.lng,color:status==="SAFE"?green:red}]} height={320}/>
        <View style={{position:"absolute",top:10,left:10,right:10,flexDirection:"row",alignItems:"center",gap:8}}>
          <View style={[styles.pill,{backgroundColor:"rgba(34,197,94,0.9)",flexDirection:"row",gap:5,alignItems:"center",paddingVertical:4,paddingHorizontal:10}]}>
            <View style={{width:6,height:6,borderRadius:3,backgroundColor:"#05300f"}}/>
            <Text style={{color:"#05300f",fontSize:11,fontWeight:"800"}}>LIVE</Text>
          </View>
          <View style={[styles.pill,{backgroundColor:"rgba(0,0,0,0.6)",flexDirection:"row",gap:5,alignItems:"center",paddingVertical:4,paddingHorizontal:10}]}>
            <Feather name="map-pin" size={11} color={white}/>
            <Text style={{color:white,fontSize:11,fontWeight:"600"}}>{driverName} is travelling</Text>
          </View>
        </View>
        </>:<View style={{height:320,borderRadius:12,backgroundColor:"#0b111a",alignItems:"center",justifyContent:"center"}}>
          <Feather name="navigation" size={32} color={muted}/>
          <Text style={{color:white,fontSize:15,fontWeight:"700",marginTop:12}}>Ready to Track</Text>
          <Text style={{color:muted,fontSize:12,marginTop:4,textAlign:"center",marginHorizontal:30}}>Tap START above to begin sharing your location</Text>
          <Pressable onPress={onStartTracking} style={{marginTop:16,backgroundColor:green,borderRadius:12,paddingVertical:12,paddingHorizontal:32,flexDirection:"row",gap:8,alignItems:"center"}}>
            <Feather name="play" size={16} color="#05300f"/>
            <Text style={{color:"#05300f",fontWeight:"800",fontSize:15}}>Start Tracking</Text>
          </Pressable>
        </View>}
      </View>
    </View>
    {isTracking?
    <View style={{flexDirection:"row",gap:10,paddingHorizontal:16,marginTop:12}}>
      <View style={[styles.card,{flex:1.4}]}>
        <View style={{flexDirection:"row",justifyContent:"space-between",alignItems:"center"}}>
          <Text style={styles.label}>CURRENT SPEED</Text>
          <View style={[styles.pill,{backgroundColor:(status==="SAFE"?"rgba(34,197,94,0.18)":"rgba(239,68,68,0.18)"),paddingVertical:3,paddingHorizontal:8}]}>
            <Text style={{color:(status==="SAFE"?green:redBright),fontSize:10,fontWeight:"700"}}>{status}</Text>
          </View>
        </View>
        <View style={{flexDirection:"row",alignItems:"baseline",gap:6,marginTop:6}}>
          <Text style={{fontSize:44,fontWeight:"800",color:(status==="SAFE"?greenBright:redBright)}}>{speed}</Text>
          <Text style={{fontSize:13,color:muted,fontWeight:"600"}}>km/h</Text>
        </View>
        <View style={{borderTopWidth:1,borderTopColor:border,marginTop:12,paddingTop:10,flexDirection:"row",justifyContent:"space-between"}}>
          <Text style={{fontSize:11,color:muted}}>Speed Limit</Text>
          <Text style={{fontSize:12,color:white,fontWeight:"700"}}>{SPEED_LIMIT} km/h</Text>
        </View>
      </View>
      <View style={{flex:1,gap:10}}>
        <View style={[styles.card,{flex:1}]}>
          <Text style={styles.labelSm}>DISTANCE</Text>
          <Text style={{fontSize:22,fontWeight:"800",color:white,marginTop:6}}>{distanceKm.toFixed(1)}</Text>
          <Text style={{fontSize:10,color:muted,fontWeight:"700"}}>KM</Text>
        </View>
        <View style={[styles.card,{flex:1}]}>
          <Text style={styles.labelSm}>DURATION</Text>
          <Text style={{fontSize:22,fontWeight:"800",color:white,marginTop:6}}>{fmtDuration(durationSec)}</Text>
          <Text style={{fontSize:10,color:muted,fontWeight:"700"}}>TIME</Text>
        </View>
      </View>
    </View>
    :<View style={{paddingHorizontal:16,marginTop:12}}>
      <View style={[styles.card,{alignItems:"center",paddingVertical:20}]}>
        <Feather name="activity" size={20} color={muted}/>
        <Text style={{color:muted,fontSize:13,marginTop:8}}>Start tracking to see speed, distance & duration</Text>
      </View>
    </View>}
    {isTracking&&<View style={[styles.card,{backgroundColor:cardBg2,marginHorizontal:16,marginTop:10,flexDirection:"row",justifyContent:"space-between"}]}>
      <View style={{flexDirection:"row",alignItems:"center",gap:6}}>
        <Feather name="map-pin" size={12} color={muted}/>
        <Text style={{color:white,fontSize:12}}>{locationName}</Text>
      </View>
      <Text style={{color:muted,fontSize:11}}>{new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</Text>
    </View>}
    <Pressable onPress={onSignOut} style={{paddingHorizontal:16,paddingVertical:10}}>
      <Text style={{color:muted,fontSize:12,textAlign:"right"}}>Sign Out</Text>
    </Pressable>
  </ScrollView>);
}

// ===== ALERTS SCREEN =====
function AlertsScreen({alerts,watchedName}:any){
  const todayStr=new Date().toISOString().slice(0,10);
  const todayAlerts=alerts.filter((a:AlertRecord)=>new Date(a.timestamp).toISOString().slice(0,10)===todayStr);
  const oc=todayAlerts.filter((a:AlertRecord)=>a.type==="alert").length;
  const sc=todayAlerts.filter((a:AlertRecord)=>a.type==="normal").length;
  return(<ScrollView style={{paddingHorizontal:16}} contentContainerStyle={{paddingBottom:20}}>
    <View style={{flexDirection:"row",justifyContent:"space-between"}}>
      <View>
        <Text style={{color:white,fontWeight:"800",fontSize:22}}>Alerts</Text>
        <Text style={{color:muted,fontSize:12,marginTop:2}}>{watchedName?`${watchedName}'s activity · ${new Date().toDateString()}`:`Today · ${new Date().toDateString()}`}</Text>
      </View>
      <View style={{flexDirection:"row",gap:8}}>
        <View style={{backgroundColor:"rgba(239,68,68,0.15)",borderRadius:10,paddingVertical:6,paddingHorizontal:12,alignItems:"center"}}>
          <Text style={{color:redBright,fontWeight:"800",fontSize:16}}>{oc}</Text>
          <Text style={{color:redBright,fontSize:8,fontWeight:"700"}}>OVER</Text>
        </View>
        <View style={{backgroundColor:"rgba(34,197,94,0.15)",borderRadius:10,paddingVertical:6,paddingHorizontal:12,alignItems:"center"}}>
          <Text style={{color:greenBright,fontWeight:"800",fontSize:16}}>{sc}</Text>
          <Text style={{color:greenBright,fontSize:8,fontWeight:"700"}}>SAFE</Text>
        </View>
      </View>
    </View>
    {todayAlerts.length===0?<View style={{marginTop:40,alignItems:"center"}}><Feather name="bell-off" size={22} color={muted}/><Text style={{color:muted,fontSize:13,marginTop:8}}>No alerts today</Text></View>
    :<View style={{marginTop:16}}>{todayAlerts.map((a:AlertRecord)=>{
      const ia=a.type==="alert";const c=ia?red:green;const b=ia?redBright:greenBright;
      return(<View key={a.id} style={{flexDirection:"row",gap:14,marginBottom:14}}>
        <View style={{width:10,alignItems:"center"}}><View style={{width:10,height:10,borderRadius:5,backgroundColor:c,marginTop:18}}/></View>
        <View style={[styles.card,{flex:1,borderLeftWidth:3,borderLeftColor:c}]}>
          <View style={{flexDirection:"row",justifyContent:"space-between",alignItems:"center"}}>
            <View style={[styles.pill,{backgroundColor:ia?"rgba(239,68,68,0.18)":"rgba(34,197,94,0.18)",flexDirection:"row",gap:5,paddingVertical:3,paddingHorizontal:9}]}>
              <Feather name={ia?"alert-triangle":"check"} size={10} color={b}/>
              <Text style={{color:b,fontSize:10,fontWeight:"700"}}>{ia?"SPEED ALERT":"SPEED NORMAL"}</Text>
            </View>
            <Text style={{fontSize:10,color:muted}}>{new Date(a.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</Text>
          </View>
          <View style={{marginTop:8}}>
            <View style={{flexDirection:"row",alignItems:"baseline"}}><Text style={{fontSize:26,fontWeight:"800",color:b}}>{a.speed}</Text><Text style={{fontSize:12,color:muted,marginLeft:4}}>km/h</Text></View>
            <View style={{flexDirection:"row",alignItems:"center",gap:4,marginTop:4}}><Feather name="map-pin" size={10} color={muted}/><Text style={{fontSize:11,color:muted}}>{a.location}</Text></View>
          </View>
        </View>
      </View>);})}
    </View>}
  </ScrollView>);
}

// ===== HISTORY SCREEN =====
function HistoryScreen({trips,liveRoute,isTracking,watchedName,elapsedSecLive}:any){
  const[selDate,setSelDate]=useState(new Date().toISOString().slice(0,10));
  const[selTrip,setSelTrip]=useState<Trip|null>(null);
  const[showDetail,setShowDetail]=useState(false);
  const[liveStartLoc,setLiveStartLoc]=useState("");
  const last7=useMemo(()=>{const d:string[]=[];for(let i=0;i<7;i++){const dt=new Date();dt.setDate(dt.getDate()-i);d.push(dt.toISOString().slice(0,10));}return d;},[]);
  useEffect(()=>{
    if(!isTracking||liveRoute.length<1){setLiveStartLoc("");return;}
    let cancelled=false;
    (async()=>{
      try{
        const r=liveRoute[0];
        const results=await Location.reverseGeocodeAsync({latitude:r.lat,longitude:r.lng});
        if(!cancelled&&results&&results.length>0){
          const res=results[0];
          setLiveStartLoc([res.street,res.district||res.city].filter(Boolean).join(", ")||"");
        }
      }catch(e){}
    })();
    return()=>{cancelled=true;};
  },[isTracking,liveRoute.length>0?liveRoute[0]?.lat:0,liveRoute.length>0?liveRoute[0]?.lng:0]);
  const filtered=trips.filter((t:Trip)=>t.date===selDate);
  const liveTrip=isTracking&&liveRoute.length>1?{id:"live",date:new Date().toISOString().slice(0,10),points:liveRoute.map((p:any)=>({lat:p.lat,lng:p.lng,speed:0,timestamp:Date.now()})),distanceKm:computeRouteDistanceKm(liveRoute),durationSec:elapsedSecLive||0,maxSpeed:0,avgSpeed:0,alertsCount:0,startedAt:Date.now(),endedAt:0,trackingStatus:"active",startLocation:liveStartLoc,endLocation:""}:null;
  const dayTrips=selDate===new Date().toISOString().slice(0,10)&&liveTrip?[liveTrip,...filtered]:filtered;
  const totalDist=dayTrips.reduce((s:number,t:Trip)=>s+t.distanceKm,0);
  const totalDur=dayTrips.reduce((s:number,t:Trip)=>s+t.durationSec,0);
  const maxSpd=Math.max(0,...dayTrips.map((t:Trip)=>t.maxSpeed));
  const totalAlerts=dayTrips.reduce((s:number,t:Trip)=>s+(t.alertsCount||0),0);
  const allPts=dayTrips.flatMap((t:Trip)=>t.points);
  return(<ScrollView style={{paddingHorizontal:16}} contentContainerStyle={{paddingBottom:20}}>
    <Text style={{color:white,fontWeight:"800",fontSize:22}}>{watchedName?`History · ${watchedName}`:"History"}</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginTop:12}} contentContainerStyle={{gap:8}}>
      {last7.map(d=>{const sel=d===selDate;const dt=new Date(d+"T12:00:00");const isT=d===new Date().toISOString().slice(0,10);return(
        <Pressable key={d} onPress={()=>setSelDate(d)} style={[styles.pill,{backgroundColor:sel?green:"rgba(255,255,255,0.06)",paddingVertical:8,paddingHorizontal:14,minWidth:60,alignItems:"center"}]}>
          <Text style={{fontSize:9,fontWeight:"700",color:sel?"#05300f":muted,textTransform:"uppercase"}}>{isT?"Today":dt.toLocaleDateString("en-US",{weekday:"short"})}</Text>
          <Text style={{fontSize:16,fontWeight:"800",color:sel?"#05300f":white,marginTop:2}}>{dt.getDate()}</Text>
          <Text style={{fontSize:9,fontWeight:"600",color:sel?"#05300f":muted}}>{dt.toLocaleDateString("en-US",{month:"short"})}</Text>
        </Pressable>);})}
    </ScrollView>
    <View style={{marginTop:12}}>
      {allPts.length>0?<LiveMap lat={allPts[allPts.length-1].lat} lng={allPts[allPts.length-1].lng} points={allPts} startPt={allPts[0]} endPt={allPts[allPts.length-1]} height={200}/>
      :<View style={{height:200,borderRadius:12,backgroundColor:"#0b111a",alignItems:"center",justifyContent:"center"}}><Feather name="map" size={20} color={muted}/><Text style={{color:muted,fontSize:12,marginTop:6}}>No trips on {fmtDate(selDate)}</Text></View>}
    </View>
    <View style={{flexDirection:"row",justifyContent:"space-between",marginTop:12,backgroundColor:cardBg,borderRadius:12,padding:12,borderWidth:1,borderColor:border}}>
      {[["DISTANCE",totalDist.toFixed(1)+" km"],["DURATION",totalDur>0?fmtDuration(totalDur):"—"],["TRIPS",""+dayTrips.length],["MAX",maxSpd+" km/h"],["ALERTS",""+totalAlerts]].map(([l,v])=>
        <View key={l} style={{alignItems:"center",flex:1}}><Text style={{fontSize:8,color:muted,fontWeight:"700"}}>{l}</Text><Text style={{fontSize:12,color:white,fontWeight:"800",marginTop:2}}>{v}</Text></View>
      )}
    </View>
    <Text style={{fontSize:11,color:muted,fontWeight:"700",marginTop:18,marginBottom:10}}>TRACKING SESSIONS</Text>
    {dayTrips.length===0?<Text style={{color:muted,fontSize:12,textAlign:"center",marginTop:10}}>No sessions on this day</Text>:
    dayTrips.map((t:Trip,i:number)=>(
      <Pressable key={t.id} onPress={()=>{setSelTrip(t);setShowDetail(true);}} style={{marginBottom:14}}>
        <View style={[styles.card,{borderLeftWidth:3,borderLeftColor:t.trackingStatus==="active"?blue:t.trackingStatus==="interrupted"?"#f59e0b":green}]}>
          <View style={{flexDirection:"row",justifyContent:"space-between",alignItems:"center"}}>
            <Text style={{color:white,fontWeight:"700",fontSize:13}}>{t.trackingStatus==="active"?"Live Session":`Session ${dayTrips.length-i}`}</Text>
            <Text style={{fontSize:10,color:muted}}>{t.startedAt?fmtTime(t.startedAt):t.points[0]?.timestamp?fmtTime(t.points[0].timestamp):""}</Text>
          </View>
          {t.points.length>1&&<View style={{borderRadius:10,overflow:"hidden",marginTop:10,height:120}}>
            <LiveMap lat={t.points[t.points.length-1]?.lat} lng={t.points[t.points.length-1]?.lng} points={t.points} startPt={t.points[0]} endPt={t.points[t.points.length-1]} height={120}/>
          </View>}
          <View style={{flexDirection:"row",gap:12,marginTop:8}}>
            <Text style={{fontSize:11,color:muted}}>{t.distanceKm.toFixed(1)} km</Text>
            <Text style={{fontSize:11,color:muted}}>{t.durationSec>0?fmtDuration(t.durationSec):"Ongoing"}</Text>
            <Text style={{fontSize:11,color:muted}}>max {t.maxSpeed} km/h</Text>
            {(t.alertsCount||0)>0&&<Text style={{fontSize:11,color:redBright,fontWeight:"700"}}>{t.alertsCount} alerts</Text>}
          </View>
          {(t.startLocation||t.endLocation)?<View style={{marginTop:8,borderTopWidth:1,borderTopColor:border,paddingTop:8}}>
            {t.startLocation?<View style={{flexDirection:"row",alignItems:"center",gap:6,marginBottom:4}}><View style={{width:7,height:7,borderRadius:4,backgroundColor:green}}/><Text style={{fontSize:11,color:white,flex:1}} numberOfLines={1}>{t.startLocation}</Text></View>:null}
            {t.endLocation?<View style={{flexDirection:"row",alignItems:"center",gap:6}}><View style={{width:7,height:7,borderRadius:4,backgroundColor:red}}/><Text style={{fontSize:11,color:white,flex:1}} numberOfLines={1}>{t.endLocation}</Text></View>:null}
          </View>:null}
        </View>
      </Pressable>
    ))}
    <Modal visible={showDetail} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={{flex:1,backgroundColor:bg}}>
        <View style={{flexDirection:"row",justifyContent:"space-between",alignItems:"center",paddingHorizontal:16,paddingVertical:12,borderBottomWidth:1,borderBottomColor:border}}>
          <Pressable onPress={()=>setShowDetail(false)} style={{flexDirection:"row",alignItems:"center",gap:6}}><Feather name="chevron-left" size={20} color={green}/><Text style={{color:green,fontWeight:"700",fontSize:14}}>Back</Text></Pressable>
          <Text style={{color:white,fontWeight:"800",fontSize:15}}>Session Details</Text><View style={{width:60}}/>
        </View>
        {selTrip&&<ScrollView contentContainerStyle={{paddingHorizontal:16,paddingTop:16,paddingBottom:30}}>
          {selTrip.points.length>0&&<LiveMap lat={selTrip.points[selTrip.points.length-1]?.lat} lng={selTrip.points[selTrip.points.length-1]?.lng} points={selTrip.points} startPt={selTrip.points[0]} endPt={selTrip.points[selTrip.points.length-1]} height={280}/>}
          <View style={[styles.card,{marginTop:14}]}><Text style={{color:white,fontWeight:"800",fontSize:15,marginBottom:12}}>Session Overview</Text>
            <View style={{flexDirection:"row",flexWrap:"wrap",gap:10}}>
              {[["DATE",selTrip.date?fmtDate(selTrip.date):"—"],["START",selTrip.startedAt?fmtTime(selTrip.startedAt):selTrip.points[0]?fmtTime(selTrip.points[0].timestamp):"—"],["END",selTrip.endedAt?fmtTime(selTrip.endedAt):selTrip.trackingStatus==="active"?"Ongoing":"—"],["DURATION",selTrip.durationSec>0?fmtDuration(selTrip.durationSec):"—"],["DISTANCE",selTrip.distanceKm.toFixed(1)+" km"],["MAX SPEED",selTrip.maxSpeed+" km/h"],["AVG SPEED",(selTrip.avgSpeed||0)+" km/h"],["ALERTS",""+(selTrip.alertsCount||0)]].map(([l,v])=>
                <View key={l} style={{width:"47%",backgroundColor:cardBg2,borderRadius:10,padding:10}}><Text style={{fontSize:9,color:muted,fontWeight:"700"}}>{l}</Text><Text style={{fontSize:15,fontWeight:"800",color:white,marginTop:4}}>{v}</Text></View>
              )}
            </View>
          </View>
           {(selTrip.startLocation||selTrip.endLocation)?<View style={[styles.card,{marginTop:10}]}><Text style={{color:white,fontWeight:"700",fontSize:13,marginBottom:8}}>Locations</Text>
             {selTrip.startLocation?<View style={{flexDirection:"row",alignItems:"center",gap:8,marginBottom:6}}><View style={{width:8,height:8,borderRadius:4,backgroundColor:green}}/><Text style={{color:white,fontSize:12}}>{selTrip.startLocation}</Text></View>:null}
             {selTrip.endLocation?<View style={{flexDirection:"row",alignItems:"center",gap:8}}><View style={{width:8,height:8,borderRadius:4,backgroundColor:red}}/><Text style={{color:white,fontSize:12}}>{selTrip.endLocation}</Text></View>:null}
           </View>:null}
        </ScrollView>}
      </SafeAreaView>
    </Modal>
  </ScrollView>);}

// ===== REPORT SCREEN =====
function BarMini({label,value}:any){const over=value>SPEED_LIMIT;const h=value?Math.min(56,(value/90)*56):4;return(<View style={{alignItems:"center",gap:4,flex:1}}><Text style={{fontSize:9,fontWeight:"700",color:over?redBright:greenBright}}>{value||"-"}</Text><View style={{height:56,justifyContent:"flex-end"}}><View style={{width:16,height:h,backgroundColor:over?red:green,borderRadius:4,opacity:value?0.9:0.25}}/></View><Text style={{fontSize:9,color:muted}}>{label}</Text></View>);}

function ReportScreen({trips,alerts,watchedName}:any){
  const[selIdx,setSelIdx]=useState(0);
  const weeklyReports=useMemo(()=>{
    if(!trips||trips.length===0)return[];
    const weekMap=new Map<string,Trip[]>();
    for(const t of trips){
      const td=new Date(t.date);
      const m=mondayOf(td);
      const key=m.toISOString().slice(0,10);
      if(!weekMap.has(key))weekMap.set(key,[]);
      weekMap.get(key)!.push(t);
    }
    const allReports:any[]=[];
    for(const[weekKey,wTrips]of weekMap){
      const monday=new Date(weekKey+"T00:00:00");
      const sunday=new Date(monday);sunday.setDate(sunday.getDate()+7);
      const wAlerts=(alerts||[]).filter((a:AlertRecord)=>{const d=new Date(a.timestamp);return d>=monday&&d<sunday;});
      const tDist=wTrips.reduce((s,t)=>s+t.distanceKm,0);
      const tTime=wTrips.reduce((s,t)=>s+t.durationSec,0);
      const mSpd=Math.max(0,...wTrips.map(t=>t.maxSpeed));
      const aPts=wTrips.flatMap(t=>t.points);
      const movingPts=aPts.filter(p=>p.speed>MIN_MOVING_KMH);
      const sPts=movingPts.filter(p=>p.speed<=SPEED_LIMIT).length;
      const sPct=movingPts.length?Math.round(sPts/movingPts.length*100):100;
      const dl=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
      const dailyMaxSpeeds=dl.map((_,i)=>{const d=new Date(monday);d.setDate(d.getDate()+i);const ds=d.toISOString().slice(0,10);return Math.max(0,...wTrips.filter(t=>t.date===ds).map(t=>t.maxSpeed));});
      const dailyOverEvents=dl.map((_,i)=>{const d=new Date(monday);d.setDate(d.getDate()+i);const c=wAlerts.filter((a:AlertRecord)=>a.type==="alert"&&new Date(a.timestamp).toDateString()===d.toDateString()).length;return c;});
      allReports.push({weekStart:monday.toISOString(),weekEnd:sunday.toISOString(),totalDistance:tDist,totalTime:tTime,totalTrips:wTrips.length,maxSpeed:mSpd,safetyScore:sPct,dailyMaxSpeeds,dailyOverEvents});
    }
    allReports.sort((a,b)=>new Date(b.weekStart).getTime()-new Date(a.weekStart).getTime());
    return allReports;
  },[trips,alerts]);
  const lr=weeklyReports.length>0?weeklyReports[Math.min(selIdx,weeklyReports.length-1)]:null;
  if(lr){const{weekStart,weekEnd,totalDistance,totalTime,totalTrips,maxSpeed,safetyScore,dailyMaxSpeeds,dailyOverEvents}=lr;const dl=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    return(<ScrollView style={{paddingHorizontal:16}}>
      <Text style={{color:white,fontWeight:"800",fontSize:20}}>{watchedName?`${watchedName}s Weekly Report`:"Weekly Report"}</Text>
      <View style={{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginTop:8}}>
        <Pressable onPress={()=>setSelIdx(Math.min(selIdx+1,weeklyReports.length-1))} disabled={selIdx>=weeklyReports.length-1} style={{opacity:selIdx>=weeklyReports.length-1?0.3:1}}><Feather name="chevron-left" size={20} color={green}/></Pressable>
        <Text style={{color:white,fontWeight:"700",fontSize:13}}>{new Date(weekStart).toLocaleDateString("en-US",{month:"short",day:"numeric"})} – {new Date(weekEnd).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</Text>
        <Pressable onPress={()=>setSelIdx(Math.max(selIdx-1,0))} disabled={selIdx<=0} style={{opacity:selIdx<=0?0.3:1}}><Feather name="chevron-right" size={20} color={green}/></Pressable>
      </View>
        {weeklyReports.length>1&&<ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginTop:8}} contentContainerStyle={{gap:6}}>
        {weeklyReports.map((r:any,i:number)=>{const active=i===selIdx; return(<Pressable key={i} onPress={()=>setSelIdx(i)} style={[styles.pill,{backgroundColor:active?green:"rgba(255,255,255,0.06)",paddingHorizontal:10,paddingVertical:4}]}>
          <Text style={{color:active?"#05300f":muted,fontSize:10,fontWeight:"700"}}>Week of {new Date(r.weekStart).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</Text>
        </Pressable>);})}
      </ScrollView>}
      <View style={{flexDirection:"row",gap:10,marginTop:14}}>
        <View style={[styles.card,{flex:1,alignItems:"center"}]}><Text style={[styles.labelSm,{alignSelf:"flex-start"}]}>SAFETY SCORE</Text><View style={{width:88,height:88,marginTop:8,marginBottom:4,alignItems:"center",justifyContent:"center",borderRadius:44,borderWidth:6,borderColor:"rgba(255,255,255,0.08)",backgroundColor:"rgba(255,255,255,0.03)"}}><Text style={{fontSize:22,fontWeight:"800",color:safetyScore>=80?green:safetyScore>=50?"#f59e0b":red}}>{safetyScore}</Text><Text style={{fontSize:9,color:muted,marginTop:-2}}>/100</Text></View></View>
        <View style={[styles.card,{flex:1}]}><Text style={[styles.labelSm,{marginBottom:10}]}>BEHAVIOR</Text>{[["Safe",safetyScore,green],["Overspeed",100-safetyScore,red]].map(([l,v,c]:any)=><View key={l} style={{marginBottom:10}}><View style={{flexDirection:"row",justifyContent:"space-between",marginBottom:4}}><Text style={{fontSize:11,color:white}}>{l}</Text><Text style={{fontSize:11,color:c,fontWeight:"700"}}>{v}%</Text></View><View style={{height:4,backgroundColor:"rgba(255,255,255,0.1)",borderRadius:2}}><View style={{height:4,width:`${v}%`,backgroundColor:c,borderRadius:2}}/></View></View>)}</View>
      </View>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:10,marginTop:10}}>      {[["TOTAL DISTANCE",totalDistance.toFixed(1),"km"],["TRAVEL TIME",fmtDuration(totalTime),""],["TOTAL TRIPS",""+totalTrips,"trips"],["MAX SPEED",""+maxSpeed,"km/h"]].map(([l,v,u])=><View key={l} style={[styles.card,{width:"47%"}]}><Text style={styles.labelSm}>{l}</Text><View style={{flexDirection:"row",alignItems:"baseline",marginTop:4}}><Text style={{fontSize:18,fontWeight:"800",color:white}}>{v}</Text>{!!u&&<Text style={{fontSize:11,color:muted,marginLeft:4}}>{u}</Text>}</View></View>)}</View>
      <View style={[styles.card,{marginTop:10}]}><Text style={{color:white,fontWeight:"700",fontSize:13}}>Max Speed Overview</Text><View style={{flexDirection:"row",gap:6,marginTop:12}}>{dl.map((l,i)=><BarMini key={l} label={l} value={dailyMaxSpeeds[i]}/>)}</View></View>
      <View style={[styles.card,{marginTop:10,marginBottom:20}]}><View style={{flexDirection:"row",justifyContent:"space-between"}}><Text style={{color:white,fontWeight:"700",fontSize:13}}>Overspeed Events</Text><Pill style={{backgroundColor:"rgba(239,68,68,0.18)"}}><Text style={{color:redBright,fontSize:9,fontWeight:"700"}}>{dailyOverEvents.reduce((a:number,b:number)=>a+b,0)} THIS WEEK</Text></Pill></View><View style={{flexDirection:"row",gap:6,marginTop:12}}>{dl.map((l,i)=><View key={l} style={{flex:1,alignItems:"center"}}><View style={{height:34,width:"100%",borderRadius:8,alignItems:"center",justifyContent:"center",backgroundColor:dailyOverEvents[i]?"rgba(239,68,68,0.22)":"rgba(255,255,255,0.05)"}}><Text style={{color:dailyOverEvents[i]?redBright:muted,fontWeight:"700",fontSize:12}}>{dailyOverEvents[i]||"-"}</Text></View><Text style={{fontSize:9,color:muted,marginTop:4}}>{l}</Text></View>)}</View></View>
    </ScrollView>);}
  const monday=mondayOf(new Date());
  return(<ScrollView style={{paddingHorizontal:16}}><Text style={{color:white,fontWeight:"800",fontSize:20}}>{watchedName?`${watchedName}s Weekly Report`:"Weekly Report"}</Text><Text style={{color:muted,fontSize:12,marginTop:2}}>{monday.toDateString()} – {new Date().toDateString()}</Text><View style={{marginTop:60,alignItems:"center"}}><Feather name="bar-chart-2" size={22} color={muted}/><Text style={{color:muted,fontSize:13,marginTop:8,textAlign:"center"}}>No trips recorded yet</Text><Text style={{color:muted,fontSize:13,textAlign:"center"}}>Start tracking to see your weekly report</Text></View></ScrollView>);}



// ===== SHARE SCREEN =====
function ShareScreen({userId,shortId,userName,userRole,isTracking,latestLocation,speed,status,supabaseReady,pushToken,notificationsReady,watchCodeInput,setWatchCodeInput,watchedDriver,watchError,watchBusy,startWatching,stopWatching}:any){
  const cp=useCallback(async()=>{if(shortId){await Clipboard.setStringAsync(shortId);Alert.alert("Copied!","Share code copied to clipboard.");}},[shortId]);
  const loc=watchedDriver?.latest_location||null;const over=watchedDriver?.status==="OVERSPEED";const uat=watchedDriver?.updated_at?new Date(watchedDriver.updated_at).getTime():0;const stale=!loc||Date.now()-uat>25000;const pts:any[]=Array.isArray(watchedDriver?.route_points)?watchedDriver.route_points:[];const isD=userRole==="driver";
  return(<ScrollView style={{paddingHorizontal:16,flex:1}}>
    <Text style={{color:white,fontWeight:"800",fontSize:22}}>Share Location</Text>
    <View style={{flexDirection:"row",alignItems:"center",gap:10,marginTop:10}}>
      <View style={[styles.logoBox,{width:38,height:38,borderRadius:19}]}><Text style={{fontWeight:"900",color:"#05300f",fontSize:14}}>{(userName||"?").trim().slice(0,1).toUpperCase()}</Text></View>
      <View style={{flex:1}}><Text style={{color:white,fontWeight:"800",fontSize:16}}>{userName||"Setting up..."}</Text><Text style={{color:muted,fontSize:11,marginTop:1}}>{isD?"Driver — share your code below":"Guardian — enter a driver's code below"}</Text></View>
    </View>
    {!supabaseReady&&<View style={[styles.card,{backgroundColor:"rgba(239,68,68,0.15)",borderColor:red,marginTop:12}]}><Text style={{color:redBright,fontWeight:"700"}}>Warning: Supabase not connected.</Text></View>}
    <View style={[styles.card,{marginTop:12,borderColor:isD?green:border}]}>
      <Text style={{color:white,fontWeight:"700",fontSize:15}}>{isD?(userName||"My")+"'s Driver Code":"Your Code"}</Text>
      <View style={{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginTop:4}}>
        <View style={{flexDirection:"row",alignItems:"center",gap:10}}>
          <Text style={{color:muted,fontSize:12}}>Share Code:</Text>
          <Text style={{color:isD?green:muted,fontWeight:"bold",fontSize:24,letterSpacing:1}}>{shortId||"Loading..."}</Text>
        </View>
        <Pressable onPress={cp} style={[styles.pill,{backgroundColor:"rgba(34,197,94,0.18)",flexDirection:"row"}]}>
          <Feather name="copy" size={16} color={green}/>
          <Text style={{color:green,marginLeft:4,fontWeight:"600"}}>Copy</Text>
        </Pressable>
      </View>
      {isD&&<Text style={{color:muted,fontSize:12,marginTop:6}}>Status: {isTracking?<Text style={{color:green,fontWeight:"bold"}}>Sharing live</Text>:<Text style={{color:red,fontWeight:"bold"}}>Not sharing</Text>}</Text>}
      {isD&&<Text style={{color:muted,fontSize:11,marginTop:8}}>Give this code to a guardian to see your live location.</Text>}
    </View>
    <View style={[styles.card,{marginTop:12,borderColor:!isD?green:border}]}>
      <Text style={{color:white,fontWeight:"700",fontSize:15}}>Watch a Driver</Text>
      <Text style={{color:muted,fontSize:12,marginBottom:8}}>Enter the DRIVER's Share Code:</Text>
      <View style={{flexDirection:"row",gap:8}}>
        <TextInput style={{flex:1,backgroundColor:cardBg2,color:white,borderRadius:8,padding:10,borderWidth:1,borderColor:border}} placeholder="e.g. A3F9Z2" placeholderTextColor={muted} value={watchCodeInput} onChangeText={setWatchCodeInput} editable={!watchBusy} autoCapitalize="characters" autoCorrect={false}/>
        <Pressable onPress={()=>startWatching(watchCodeInput)} disabled={watchBusy} style={[styles.pill,{backgroundColor:watchBusy?muted:green}]}>
          <Text style={{color:"#05300f",fontWeight:"700"}}>{watchBusy?"Finding...":"Watch"}</Text>
        </Pressable>
      </View>
      {watchError.length>0&&<Text style={{color:redBright,fontSize:12,marginTop:6}}>{watchError}</Text>}
      {watchedDriver!=null&&<View style={{marginTop:12,borderTopWidth:1,borderTopColor:border,paddingTop:12,borderLeftWidth:4,borderLeftColor:stale?muted:over?red:green,paddingLeft:10}}>
        <View style={{flexDirection:"row",justifyContent:"space-between",alignItems:"center"}}>
          <Text style={{color:white,fontWeight:"700"}}>{"Watching: "}{watchedDriver.name||"Driver"}{" ("}{watchedDriver.short_id||""}{")"}</Text>
          <Pressable onPress={stopWatching} style={[styles.pill,{backgroundColor:"rgba(239,68,68,0.18)"}]}>
            <Text style={{color:redBright,fontWeight:"700"}}>Stop</Text>
          </Pressable>
        </View>
        {loc!=null&&<View style={{marginTop:8}}>
          <LiveMap lat={loc.lat} lng={loc.lng} points={pts} pins={[{lat:loc.lat,lng:loc.lng,color:over?red:green}]} height={200}/>
        </View>}
        {loc!=null&&<View style={{flexDirection:"row",justifyContent:"space-between",marginTop:8}}>
          <Text style={{color:white}}>{"Speed: "}{Math.round(watchedDriver.speed||0)}{" km/h"}</Text>
          <Text style={{color:stale?muted:over?redBright:greenBright,fontWeight:"700"}}>{stale?"OFFLINE":over?"OVERSPEED":"SAFE"}</Text>
        </View>}
        {loc==null&&<Text style={{color:muted,marginTop:8}}>{"Waiting for the driver to start sharing. (driver must tap Start)"}</Text>}
      </View>}
    </View>
  </ScrollView>);
}

// ===== LOGIN SCREEN =====
function LoginScreen({onLogin,supabaseReady}:any){
  const[mode,setMode]=useState<"signin"|"signup">("signin");
  const[email,setEmail]=useState("");
  const[password,setPassword]=useState("");
  const[name,setName]=useState("");
  const[userRole,setUserRole]=useState<"driver"|"guardian">("driver");
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState("");
  const[showPassword,setShowPassword]=useState(false);
  const[signUpDone,setSignUpDone]=useState(false);

  const isValid=email.trim().length>3&&password.length>=6&&(mode==="signin"||name.trim().length>0);

  const handleSubmit=useCallback(async()=>{
    if(!isValid||busy)return;
    setBusy(true);setError("");
    if(mode==="signup"){
      const result=await signUp(email,password,name.trim(),userRole);
      if(result.error){
        setError(result.error);
        setBusy(false);
        return;
      }
      if(result.needsConfirmation){
        setError("");
        setSignUpDone(true);
        setBusy(false);
        return;
      }
      if(result.user){
        await AsyncStorage.setItem("sr_state",JSON.stringify({
          setupDone:true,
          userName:result.user.name,
          userRole:result.user.role,
          userId:result.user.id,
          shortId:result.user.shortId,
          email:result.user.email,
        }));
        onLogin(result.user);
      }
    }else{
      const result=await signIn(email,password);
      if(result.error){
        setError(result.error);
        setBusy(false);
        return;
      }
      if(result.user){
        await AsyncStorage.setItem("sr_state",JSON.stringify({
          setupDone:true,
          userName:result.user.name,
          userRole:result.user.role,
          userId:result.user.id,
          shortId:result.user.shortId,
          email:result.user.email,
        }));
        onLogin(result.user);
      }
    }
    setBusy(false);
  },[email,password,name,userRole,mode,isValid,busy]);

  return(<View style={{paddingHorizontal:24,justifyContent:"center",flex:1}}>
    <View style={{alignItems:"center",marginBottom:32}}>
      <View style={{width:72,height:72,borderRadius:18,backgroundColor:green,alignItems:"center",justifyContent:"center",marginBottom:16}}>
        <Text style={{fontWeight:"900",color:"#05300f",fontSize:26}}>SR</Text>
      </View>
      <Text style={{color:white,fontWeight:"900",fontSize:30,marginBottom:8}}>SafeRide</Text>
      <Text style={{color:muted,fontSize:14,textAlign:"center"}}>{mode==="signin"?"Sign in to your account":"Create your account"}</Text>
    </View>
    <View style={[styles.card,{padding:20}]}>
      {mode==="signup"&&<>
        <Text style={styles.labelSm}>YOUR NAME</Text>
        <View style={{flexDirection:"row",alignItems:"center",backgroundColor:cardBg2,borderRadius:10,borderWidth:1,borderColor:border,marginTop:8,paddingHorizontal:12}}>
          <Feather name="user" size={18} color={muted}/>
          <TextInput style={{flex:1,color:white,fontSize:15,padding:12}} value={name} onChangeText={setName} placeholder="e.g. Dheeraj" placeholderTextColor={muted} autoCapitalize="words"/>
        </View>
      </>}
      <Text style={[styles.labelSm,{marginTop:16}]}>EMAIL</Text>
      <View style={{flexDirection:"row",alignItems:"center",backgroundColor:cardBg2,borderRadius:10,borderWidth:1,borderColor:border,marginTop:8,paddingHorizontal:12}}>
        <Feather name="mail" size={18} color={muted}/>
        <TextInput style={{flex:1,color:white,fontSize:15,padding:12}} value={email} onChangeText={(t)=>{setEmail(t);setError("");}} placeholder="you@example.com" placeholderTextColor={muted} keyboardType="email-address" autoCapitalize="none" autoCorrect={false}/>
      </View>
      <Text style={[styles.labelSm,{marginTop:16}]}>PASSWORD</Text>
      <View style={{flexDirection:"row",alignItems:"center",backgroundColor:cardBg2,borderRadius:10,borderWidth:1,borderColor:border,marginTop:8,paddingHorizontal:12}}>
        <Feather name="lock" size={18} color={muted}/>
        <TextInput style={{flex:1,color:white,fontSize:15,padding:12}} value={password} onChangeText={(t)=>{setPassword(t);setError("");}} placeholder="Min 6 characters" placeholderTextColor={muted} secureTextEntry={!showPassword}/>
        <Pressable onPress={()=>setShowPassword(!showPassword)} style={{padding:4}}>
          <Feather name={showPassword?"eye-off":"eye"} size={18} color={muted}/>
        </Pressable>
      </View>
      {mode==="signup"&&<>
        <Text style={[styles.labelSm,{marginTop:20}]}>I AM A...</Text>
        <View style={{flexDirection:"row",gap:10,marginTop:8}}>
          <Pressable onPress={()=>setUserRole("driver")} style={{flex:1,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:8,backgroundColor:userRole==="driver"?"rgba(34,197,94,0.15)":"transparent",borderRadius:12,paddingVertical:14,borderWidth:1.5,borderColor:userRole==="driver"?green:border}}>
            <Feather name="navigation" size={16} color={userRole==="driver"?green:muted}/>
            <Text style={{color:userRole==="driver"?white:muted,fontWeight:"700",fontSize:15}}>Driver</Text>
          </Pressable>
          <Pressable onPress={()=>setUserRole("guardian")} style={{flex:1,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:8,backgroundColor:userRole==="guardian"?"rgba(34,197,94,0.15)":"transparent",borderRadius:12,paddingVertical:14,borderWidth:1.5,borderColor:userRole==="guardian"?green:border}}>
            <Feather name="shield" size={16} color={userRole==="guardian"?green:muted}/>
            <Text style={{color:userRole==="guardian"?white:muted,fontWeight:"700",fontSize:15}}>Guardian</Text>
          </Pressable>
        </View>
        <Text style={{color:muted,fontSize:12,marginTop:8}}>{userRole==="driver"?"Driver = the phone that travels and gets tracked.":"Guardian = the phone that monitors someone's safety."}</Text>
      </>}
      {signUpDone?<View style={{backgroundColor:"rgba(34,197,94,0.15)",borderRadius:10,padding:14,marginTop:10,borderWidth:1,borderColor:green}}>
        <View style={{flexDirection:"row",alignItems:"center",gap:8,marginBottom:8}}>
          <Feather name="check-circle" size={18} color={green}/>
          <Text style={{color:green,fontWeight:"700",fontSize:14}}>Account Created!</Text>
        </View>
        <Text style={{color:white,fontSize:13,lineHeight:18}}>Check your email <Text style={{fontWeight:"700"}}>{email}</Text> and click the confirmation link.</Text>
        <Text style={{color:muted,fontSize:12,marginTop:8,lineHeight:16}}>After confirming, come back here and sign in with your email and password.</Text>
        <Pressable onPress={()=>{setSignUpDone(false);setMode("signin");}} style={{marginTop:12,backgroundColor:green,borderRadius:8,paddingVertical:10,alignItems:"center"}}>
          <Text style={{color:"#05300f",fontWeight:"700",fontSize:13}}>Go to Sign In</Text>
        </Pressable>
      </View>:null}
      {error?<Text style={{color:redBright,fontSize:12,marginTop:10}}>{error}</Text>:null}
      {!signUpDone&&<Pressable onPress={handleSubmit} disabled={!isValid||busy} style={[styles.btnPrimary,{marginTop:16,opacity:isValid&&!busy?1:0.4}]}>
        <Text style={{color:"#05300f",fontWeight:"800",fontSize:16}}>{busy?(mode==="signup"?"Creating account...":"Signing in..."):(mode==="signup"?"Create Account":"Sign In")}</Text>
      </Pressable>}
      {!signUpDone&&<Pressable onPress={()=>{setMode(mode==="signin"?"signup":"signin");setError("");}} style={{marginTop:14,alignItems:"center"}}>
        <Text style={{color:muted,fontSize:13}}>
          {mode==="signin"?"Don't have an account? ":"Already have an account? "}
          <Text style={{color:green,fontWeight:"700"}}>{mode==="signin"?"Sign Up":"Sign In"}</Text>
        </Text>
      </Pressable>}
    </View>
    {!supabaseReady&&<View style={[styles.card,{backgroundColor:"rgba(239,68,68,0.15)",borderColor:red,marginTop:12}]}>
      <Text style={{color:redBright,fontWeight:"700",fontSize:12}}>Server offline — sign up requires internet connection.</Text>
    </View>}
  </View>);
}

// ===== MAIN APP =====
function InAppBanner({notifs,dismiss}:{notifs:{id:string;title:string;body:string;color:string;icon:string;ts:number}[];dismiss:(id:string)=>void;}){
  if(notifs.length===0)return null;
  return(<View style={{position:"absolute",top:0,left:0,right:0,zIndex:9999,elevation:9999,paddingTop:40}}>
    {notifs.map(n=>(
      <Pressable key={n.id} onPress={()=>dismiss(n.id)} style={{marginHorizontal:12,marginBottom:8,backgroundColor:"#1a2433",borderRadius:14,padding:14,borderWidth:1,borderColor:n.color,flexDirection:"row",alignItems:"center",gap:10,shadowColor:n.color,shadowOffset:{width:0,height:2},shadowOpacity:0.3,shadowRadius:8,elevation:8}}>
        <View style={{width:36,height:36,borderRadius:10,backgroundColor:n.color+"22",alignItems:"center",justifyContent:"center"}}><Feather name={n.icon as any} size={18} color={n.color}/></View>
        <View style={{flex:1}}>
          <Text style={{color:white,fontWeight:"700",fontSize:13}}>{n.title}</Text>
          <Text style={{color:muted,fontSize:11,marginTop:2}} numberOfLines={2}>{n.body}</Text>
        </View>
        <Feather name="x" size={14} color={muted}/>
      </Pressable>
    ))}
  </View>);
}

export default function App(){
  const[appState,setAppState]=useState(AppState.currentState);
  const[authUser,setAuthUser]=useState<AuthUser|null>(null);
  const[setupDone,setSetupDone]=useState(false);
  const[userName,setUserName]=useState("");
  const[userRole,setUserRole]=useState("driver");
  const[userId,setUserId]=useState("");
  const[shortId,setShortId]=useState("");
  const[activeTab,setActiveTab]=useState("home");

  // Location state
  const[location,setLocation]=useState<LatLng|null>(null);
  const[isTracking,setIsTracking]=useState(false);
  const[speed,setSpeed]=useState(0);
  const[routePoints,setRoutePoints]=useState<LatLng[]>([]);
  const[totalDistKm,setTotalDistKm]=useState(0);
  const[elapsedSec,setElapsedSec]=useState(0);
  const[status,setStatus]=useState<"SAFE"|"OVERSPEED">("SAFE");
  const[alerts,setAlerts]=useState<AlertRecord[]>([]);
  const sessionAlertsRef=useRef<AlertRecord[]>([]);

  // Trips & reports
  const[trips,setTrips]=useState<Trip[]>([]);
  const[weeklyReports,setWeeklyReports]=useState<any[]>([]);

  // Share / watch state
  const[watchCodeInput,setWatchCodeInput]=useState("");
  const[watchedDriver,setWatchedDriver]=useState<any>(null);
  const[watchError,setWatchError]=useState("");
  const[watchBusy,setWatchBusy]=useState(false);
  const[watchSub,setWatchSub]=useState<any>(null);
  const[watchedTrips,setWatchedTrips]=useState<Trip[]>([]);
  const[watchedAlerts,setWatchedAlerts]=useState<AlertRecord[]>([]);
  const watchedDriverTrackingRef=useRef(false);

  // Notifications / push
  const[pushToken,setPushToken]=useState<string|null>(null);
  const[notificationsReady,setNotificationsReady]=useState(false);

  // In-app notification banners
  type InAppNotif={id:string;title:string;body:string;color:string;icon:string;ts:number;};
  const[inAppNotifs,setInAppNotifs]=useState<InAppNotif[]>([]);
  const inAppNotifIdRef=useRef(0);
  const addInAppNotif=useCallback((title:string,body:string,color:string,icon:string)=>{
    const id="inapp-"+(++inAppNotifIdRef.current);
    setInAppNotifs(prev=>[{id,title,body,color,icon,ts:Date.now()},...prev].slice(0,20));
    setTimeout(()=>{setInAppNotifs(prev=>prev.filter(n=>n.id!==id));},6000);
  },[]);

  // Local notification helper (for driver's own phone)
  const scheduleLocalNotif=useCallback(async(title:string,body:string)=>{
    if(!notificationsReady)return;
    try{
      const Notifications=require("expo-notifications");
      if(Notifications&&typeof Notifications.scheduleNotificationAsync==="function"){
        await Notifications.scheduleNotificationAsync({content:{title,body,sound:true},trigger:null});
      }
    }catch(e){}
  },[notificationsReady]);

  // Supabase
  const[supabaseReady,setSupabaseReady]=useState(false);

  // Online status
  const[isOnline,setIsOnline]=useState(true);

  // Foreground sub ref
  const bgIntervalRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const watchSubRef = useRef<Location.LocationSubscription|null>(null);
  const speedHistRef = useRef<number[]>([]);
  const statusRef = useRef<"SAFE"|"OVERSPEED">("SAFE");

  // Refs for background save (avoids stale closures)
  const routePointsRef = useRef<LatLng[]>([]);
  const totalDistKmRef = useRef(0);
  const elapsedSecRef = useRef(0);
  const alertsRef = useRef<AlertRecord[]>([]);
  const supabaseReadyRef = useRef(false);
  const userIdRef = useRef("");
  const isTrackingRef = useRef(false);
  const locationRef = useRef<LatLng|null>(null);
  const loadTripsRef = useRef<(()=>Promise<void>)|null>(null);
  const trackingStartTimeRef = useRef<number>(0);
  const speedRef = useRef(0);
  const lastLocationTimestampRef = useRef<number>(0);

  // ---- Init: load saved state ----
  const[initLoading,setInitLoading]=useState(true);
  useEffect(()=>{
    (async()=>{
      try{
        // Check for existing auth session (auto-login)
        const user=await getCurrentUser();
        if(user){
          setAuthUser(user);
          setSetupDone(true);
          setUserName(user.name);
          setUserRole(user.role);
          setUserId(user.id);
          setShortId(user.shortId);
          await AsyncStorage.setItem("sr_state",JSON.stringify({setupDone:true,userName:user.name,userRole:user.role,userId:user.id,shortId:user.shortId,email:user.email}));
          await AsyncStorage.setItem("userId",user.id);
          await AsyncStorage.setItem("userName",user.name);
          setInitLoading(false);
          return;
        }
        // Fallback: check local storage for legacy session
        const saved=await AsyncStorage.getItem("sr_state");
        if(saved){
          const s=JSON.parse(saved);
          if(s.setupDone&&s.userId){
            setSetupDone(true);
            setUserName(s.userName||"");
            setUserRole(s.userRole||"driver");
            setUserId(s.userId||"");
            setShortId(s.shortId||"");
          }
        }
      }catch(e){console.warn("Init error",e);}
      setInitLoading(false);
    })();
  },[]);

  // ---- Init: supabase, notifications, netinfo ----
  useEffect(()=>{
    const initAsync=async()=>{
      try{
        const ns=await NetInfo.fetch();
        setIsOnline(ns.isConnected!==false);
      }catch(e){}
      try{
        const{error}=await supabase.from("users").select("id").limit(1);
        if(!error){setSupabaseReady(true);}else{console.warn("[SafeRide] Supabase query failed:",error.message);}
      }catch(e){console.warn("[SafeRide] Supabase init error:",e);}
      try{
        // expo-notifications: fully removed from Expo Go on Android (SDK 53+)
        // - even importing it throws there. Skip in that environment.
        const notifAvailable=!isExpoGo||Platform.OS!=="android";
        if(notifAvailable){
          try{
            const Notifications=require("expo-notifications");
            if(Notifications&&typeof Notifications.setNotificationHandler==="function"){
              Notifications.setNotificationHandler({
                handleNotification:async()=>({shouldShowAlert:true,shouldPlaySound:true,shouldSetBadge:false}),
              });
              const{status:notifStatus}=await Notifications.requestPermissionsAsync();
              setNotificationsReady(notifStatus==="granted");
              // Remote push token (so OTHER phones can alert this one while app is closed)
              if(notifStatus==="granted"&&!isExpoGo){
                try{
                  const projectId=Constants.expoConfig?.extra?.eas?.projectId||Constants.easConfig?.projectId;
                  if(projectId){
                    const tokenResult=await Notifications.getExpoPushTokenAsync({projectId});
                    setPushToken(tokenResult.data);
                    // Update push token in Supabase via auth module
                    updatePushToken(tokenResult.data).catch(()=>{});
                  }
                }catch(e){console.warn("Push token registration failed:",e);}
              }
            }
          }catch(e){console.warn("Local notifications unavailable:",e);}
        }
      }catch(e){}
    };
    initAsync();
    const unsubNet=NetInfo.addEventListener(s=>setIsOnline(s.isConnected!==false));
    return()=>{unsubNet();};
  },[]);

  // ---- Update user in supabase ----
  useEffect(()=>{
    if(!supabaseReady||!userId||!userName)return;
    (async()=>{
      try{
        // Check if this user already has a short_id in Supabase - NEVER change it
        const{data:existingMe}=await supabase.from("users").select("short_id").eq("id",userId).maybeSingle();
        let finalShortId=existingMe?.short_id||shortId;
        // Only check conflicts if this user has no short_id in Supabase yet
        if(!existingMe?.short_id){
          const{data:conflict}=await supabase.from("users").select("id").eq("short_id",shortId).neq("id",userId).maybeSingle();
          if(conflict){
            for(let suffix=0;suffix<100;suffix++){
              const s=String(suffix).padStart(2,"0");
              const attempt=shortId.slice(0,4)+s;
              const{data:check}=await supabase.from("users").select("id").eq("short_id",attempt).neq("id",userId).maybeSingle();
              if(!check){finalShortId=attempt;break;}
            }
          }
          setShortId(finalShortId);
          await AsyncStorage.setItem("sr_state",JSON.stringify({setupDone,userName,userRole,userId,shortId:finalShortId}));
        }
        const{error:upsertErr}=await supabase.from("users").upsert({id:userId,email:authUser?.email||userName+"@placeholder.local",name:userName,role:userRole,short_id:finalShortId,push_token:pushToken,updated_at:new Date().toISOString()},{onConflict:"id"});
        if(upsertErr)console.warn("[SafeRide] User upsert error:",upsertErr.message);
        else console.log("[SafeRide] User upserted. Id:",userId,"ShortId:",finalShortId);
      }catch(e){console.warn("[SafeRide] User upsert exception:",e);}
    })();
  },[userId,userName,userRole,shortId,pushToken,supabaseReady,authUser]);

  // ---- Save state to storage ----
  useEffect(()=>{
    if(setupDone){
      AsyncStorage.setItem("sr_state",JSON.stringify({setupDone,userName,userRole,userId,shortId}));
      // Also save userId and userName separately for background tasks
      if(userId)AsyncStorage.setItem("userId",userId);
      if(userName)AsyncStorage.setItem("userName",userName);
    }
  },[setupDone,userName,userRole,userId,shortId]);

  // ---- Sync refs for background save ----
  useEffect(()=>{routePointsRef.current=routePoints;},[routePoints]);
  useEffect(()=>{totalDistKmRef.current=totalDistKm;},[totalDistKm]);
  useEffect(()=>{elapsedSecRef.current=elapsedSec;},[elapsedSec]);
  useEffect(()=>{alertsRef.current=sessionAlertsRef.current;},[alerts]);
  useEffect(()=>{supabaseReadyRef.current=supabaseReady;},[supabaseReady]);
  useEffect(()=>{userIdRef.current=userId;},[userId]);
  useEffect(()=>{isTrackingRef.current=isTracking;},[isTracking]);
  useEffect(()=>{locationRef.current=location;},[location]);
  useEffect(()=>{speedRef.current=speed;},[speed]);

  // ---- Recover tracking state on app restart ----
  useEffect(()=>{
    (async()=>{
      try{
        const trackingActive=await AsyncStorage.getItem("trackingActive");
        if(trackingActive==="true"&&userId){
          console.log("[SafeRide] Recovering active background tracking");
          setIsTracking(true);
          // Pull in accumulated background data
          const bg=await readBackgroundData();
          if(bg&&bg.points&&bg.points.length>0){
            const lastPt=bg.points[bg.points.length-1];
            setLocation({lat:lastPt.lat,lng:lastPt.lng});
            setSpeed(lastPt.speed);
            if(bg.status){statusRef.current=bg.status;setStatus(bg.status);}
            setRoutePoints(bg.points.map(p=>({lat:p.lat,lng:p.lng})));
            setTotalDistKm(bg.distance);
            if(bg.startTime)setElapsedSec(Math.round((Date.now()-bg.startTime)/1000));
            trackingStartTimeRef.current=bg.startTime;
          }
        }
      }catch(e){}
    })();
  },[]);

  // ---- Background tasks ----
  useEffect(()=>{
    if(isTracking){
      registerBackgroundTasks().catch(()=>{});
      startBackgroundLocation().catch(()=>{});
    }else{
      stopBackgroundLocation().catch(()=>{});
    }
  },[isTracking,userId]);

  // ---- Reverse geocode helper ----
  const reverseGeocode=useCallback(async(lat:number,lng:number):Promise<string>=>{
    try{
      const results=await Location.reverseGeocodeAsync({latitude:lat,longitude:lng});
      if(results&&results.length>0){const r=results[0];return[r.street,r.district||r.city].filter(Boolean).join(", ")||"Unknown location";}
    }catch(e){}
    return "Unknown location";
  },[]);

  // ---- Foreground location watch (with speed pipeline matching background) ----
  useEffect(()=>{
    if(!isTracking){if(watchSubRef.current){watchSubRef.current.remove();watchSubRef.current=null;}return;}
    speedHistRef.current=[];
    statusRef.current="SAFE";
    let first=true;
    Location.watchPositionAsync({accuracy:Location.Accuracy.High,timeInterval:5000,distanceInterval:3},async(loc)=>{
      const{latitude,longitude,speed:rawSpd,accuracy}=loc.coords;
      if(first){
        first=false;
        locationRef.current={lat:latitude,lng:longitude};
        setLocation(locationRef.current);
        setRoutePoints([{lat:latitude,lng:longitude}]);
        setElapsedSec(0);
        // Push initial location to Supabase immediately
        if(supabaseReadyRef.current&&userIdRef.current){
          try{await supabase.from("users").update({latest_location:{lat:latitude,lng:longitude,distance:0},speed:0,status:"SAFE",route_points:[{lat:latitude,lng:longitude}],tracking_active:true,updated_at:new Date().toISOString()}).eq("id",userIdRef.current);}catch(e){}
        }
        return;
      }
      const prev=locationRef.current;if(!prev)return;

      // Speed pipeline (matches background task)
      const acc=typeof accuracy==="number"?accuracy:999;
      let rawKmh=rawSpd&&rawSpd>0?rawSpd*3.6:0;
      if(acc>25)rawKmh=0;
      speedHistRef.current.push(rawKmh);
      if(speedHistRef.current.length>5)speedHistRef.current.shift();
      const sorted=[...speedHistRef.current].sort((a,b)=>a-b);
      const medianKmh=sorted[Math.floor(sorted.length/2)];
      const speedKmh=medianKmh<MIN_MOVING_KMH?0:Math.round(medianKmh);

      const newLoc={lat:latitude,lng:longitude};
      const dKm=haversineKm(prev.lat,prev.lng,latitude,longitude);
      locationRef.current=newLoc;
      setLocation(newLoc);
      setSpeed(speedKmh);
      setRoutePoints(rp=>[...rp,newLoc]);
      if(dKm>0.01&&speedKmh>0&&acc<=50)setTotalDistKm(td=>td+dKm);
      // Use actual GPS timestamp for elapsed time (BUG 9 fix)
      if(lastLocationTimestampRef.current>0){
        const deltaSec=Math.round((loc.timestamp-lastLocationTimestampRef.current)/1000);
        if(deltaSec>0&&deltaSec<30)setElapsedSec(e=>e+deltaSec);
      }
      lastLocationTimestampRef.current=loc.timestamp;

      // Status hysteresis (matches background task)
      // Require at least 3 samples before triggering overspeed (prevents GPS noise false positives when stationary)
      const hasEnoughSamples=speedHistRef.current.length>=3;
      const newStatus:"SAFE"|"OVERSPEED"=!hasEnoughSamples?"SAFE":
        statusRef.current==="OVERSPEED"
          ?(speedKmh<SPEED_LIMIT-SAFE_BUFFER_KMH?"SAFE":"OVERSPEED")
          :(speedKmh>SPEED_LIMIT?"OVERSPEED":"SAFE");

      if(newStatus!==statusRef.current){
        statusRef.current=newStatus;
        setStatus(newStatus);
        const locName=await reverseGeocode(latitude,longitude);
        const type=newStatus==="OVERSPEED"?"alert":"normal";
        const a:AlertRecord={id:Date.now().toString(),lat:latitude,lng:longitude,speed:speedKmh,location:locName,timestamp:Date.now(),type};
        setAlerts(al=>[a,...al]);
        sessionAlertsRef.current=[a,...sessionAlertsRef.current];
        // Save alert to supabase
        if(supabaseReady&&userId){
          try{await supabase.from("alerts").insert({user_id:userId,type,speed:speedKmh,location:locName,timestamp:new Date().toISOString()});}catch(e){console.warn("Alert insert failed:",e);}
        }
        // Push to guardians — only for OVERSPEED, not for returning to SAFE (avoids notification spam)
        if(newStatus==="OVERSPEED"){
          addInAppNotif("Speed Alert!",`You are going ${speedKmh} km/h — above the limit!`,"#ef4444","alert-triangle");
          scheduleLocalNotif("Speed Alert!",`You are going ${speedKmh} km/h — above the limit!`);
          pushToGuardians(userId,`⚠️ Speed Alert!`,`${userName||"Driver"} is going ${speedKmh} km/h near ${locName}`,{type:"alert",lat:latitude,lng:longitude,speed:speedKmh});
        }
      }
    }).then(sub=>{watchSubRef.current=sub;});
    return()=>{if(watchSubRef.current){watchSubRef.current.remove();watchSubRef.current=null;}};
  },[isTracking,userId,supabaseReady,userName,reverseGeocode,addInAppNotif,scheduleLocalNotif]);

  // ---- Periodic background sync (pulls bg data into foreground state) ----
  useEffect(()=>{
    if(!isTracking){if(bgIntervalRef.current){clearInterval(bgIntervalRef.current);bgIntervalRef.current=null;}return;}
    bgIntervalRef.current=setInterval(async()=>{
      try{
        const bg=await readBackgroundData();
        if(bg&&bg.points&&bg.points.length>0){
          const lastPt=bg.points[bg.points.length-1];
          setLocation({lat:lastPt.lat,lng:lastPt.lng});
          setSpeed(lastPt.speed);
          if(bg.status){
            statusRef.current=bg.status;
            setStatus(bg.status);
          }
          setRoutePoints(bg.points.map(p=>({lat:p.lat,lng:p.lng})));
          setTotalDistKm(bg.distance);
          if(bg.startTime)setElapsedSec(Math.round((Date.now()-bg.startTime)/1000));
        }
      }catch(e){}
    },3000);
    return()=>{if(bgIntervalRef.current)clearInterval(bgIntervalRef.current);};
  },[isTracking]);

  // ---- Foreground: push location to Supabase periodically so guardians see live updates ----
  const fgPushRef=useRef<ReturnType<typeof setInterval>|null>(null);
  useEffect(()=>{
    if(!isTracking||!supabaseReady||!userId){
      if(fgPushRef.current){clearInterval(fgPushRef.current);fgPushRef.current=null;}
      return;
    }
    fgPushRef.current=setInterval(async()=>{
      const loc=locationRef.current;
      if(!loc)return;
      const pts=routePointsRef.current;
      const dist=totalDistKmRef.current;
      const spd=speedHistRef.current.length>0?
        (()=>{const s=[...speedHistRef.current].sort((a,b)=>a-b);return Math.round(s[Math.floor(s.length/2)]||0);})():0;
      try{
        await supabase.from("users").update({
          latest_location:{lat:loc.lat,lng:loc.lng,distance:dist},
          speed:spd,
          status:statusRef.current,
          route_points:pts.slice(-100).map(p=>({lat:p.lat,lng:p.lng})),
          tracking_active:true,
          updated_at:new Date().toISOString(),
        }).eq("id",userId);
      }catch(e){}
    },5000);
    return()=>{if(fgPushRef.current){clearInterval(fgPushRef.current);fgPushRef.current=null;}};
  },[isTracking,supabaseReady,userId]);

  // ---- App state listener (foreground/background) ----
  useEffect(()=>{
    const sub=AppState.addEventListener("change",async(next)=>{
      setAppState(next);
      if(next==="active"&&isTrackingRef.current){
        const bg=await readBackgroundData();
        if(bg&&bg.points&&bg.points.length>0){
          const lastPt=bg.points[bg.points.length-1];
          setLocation({lat:lastPt.lat,lng:lastPt.lng});
          setSpeed(lastPt.speed);
          if(bg.status){
            statusRef.current=bg.status;
            setStatus(bg.status);
          }
          setRoutePoints(bg.points.map(p=>({lat:p.lat,lng:p.lng})));
          setTotalDistKm(bg.distance);
          if(bg.startTime){trackingStartTimeRef.current=bg.startTime;setElapsedSec(Math.round((Date.now()-bg.startTime)/1000));}
        }
      }
    });
    return()=>{sub.remove();};
  },[]);

  // ---- Load trips ----
  useEffect(()=>{
    if(!supabaseReady||!userId)return;
    const loadTrips=async()=>{
      try{
        const{data,error:loadErr}=await supabase.from("trips").select("*").eq("user_id",userId).order("created_at",{ascending:false}).limit(100);
        if(loadErr){console.warn("[SafeRide] Load trips error:",loadErr.message);return;}
        if(data){
          console.log("[SafeRide] Loaded",data.length,"trips from Supabase");
          setTrips(data.map((t:any)=>({id:t.id,date:t.date?new Date(t.date).toISOString().slice(0,10):"",points:t.points||[],distanceKm:t.distance_km||0,durationSec:t.duration_sec||0,maxSpeed:t.max_speed||0,avgSpeed:t.avg_speed||0,alertsCount:t.alerts_count||0,startedAt:t.started_at?new Date(t.started_at).getTime():0,endedAt:t.ended_at?new Date(t.ended_at).getTime():0,trackingStatus:t.tracking_status||"completed",startLocation:t.start_location||"",endLocation:t.end_location||"",guardianNotified:t.guardian_notified||false})));
        }
      }catch(e){console.warn("[SafeRide] Load trips exception:",e);}
    };
    loadTripsRef.current=loadTrips;
    loadTrips();
    const interval=setInterval(loadTrips,15000);
    return()=>clearInterval(interval);
  },[supabaseReady,userId]);

  // ---- Load alerts from supabase on init ----
  useEffect(()=>{
    if(!supabaseReady||!userId)return;
    const loadAlerts=async()=>{
      try{
        const{data}=await supabase.from("alerts").select("*").eq("user_id",userId).order("timestamp",{ascending:false}).limit(200);
        if(data){
          const cloudAlerts:AlertRecord[]=data.map((r:any)=>({id:r.id,type:r.type,speed:Number(r.speed||0),location:r.location||"Unknown location",timestamp:new Date(r.timestamp).getTime(),lat:r.lat,lng:r.lng}));
          setAlerts(prev=>{
            const ids=new Set(prev.map(a=>a.id));
            const merged=[...prev,...cloudAlerts.filter(a=>!ids.has(a.id))];
            return merged.sort((a,b)=>b.timestamp-a.timestamp).slice(0,200);
          });
        }
      }catch(e){}
    };
    loadAlerts();
    const interval=setInterval(loadAlerts,30000);
    return()=>clearInterval(interval);
  },[supabaseReady,userId]);

  // ---- Generate weekly report from trips & alerts ----
  useEffect(()=>{
    if(trips.length===0&&alerts.length===0){setWeeklyReports([]);return;}
    // Group trips by week (key = monday ISO date)
    const weekMap=new Map<string,Trip[]>();
    for(const t of trips){
      const td=new Date(t.date);
      const m=mondayOf(td);
      const key=m.toISOString().slice(0,10);
      if(!weekMap.has(key))weekMap.set(key,[]);
      weekMap.get(key)!.push(t);
    }
    const allReports:any[]=[];
    for(const[weekKey,wTrips]of weekMap){
      const monday=new Date(weekKey+"T00:00:00");
      const sunday=new Date(monday);sunday.setDate(sunday.getDate()+7);
      const wAlerts=alerts.filter((a:AlertRecord)=>{const d=new Date(a.timestamp);return d>=monday&&d<sunday;});
      const tDist=wTrips.reduce((s,t)=>s+t.distanceKm,0);
      const tTime=wTrips.reduce((s,t)=>s+t.durationSec,0);
      const mSpd=Math.max(0,...wTrips.map(t=>t.maxSpeed));
      const aPts=wTrips.flatMap(t=>t.points);
      const movingPts=aPts.filter(p=>p.speed>MIN_MOVING_KMH);
      const sPts=movingPts.filter(p=>p.speed<=SPEED_LIMIT).length;
      const sPct=movingPts.length?Math.round(sPts/movingPts.length*100):100;
      const dl=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
      const dailyMaxSpeeds=dl.map((_,i)=>{const d=new Date(monday);d.setDate(d.getDate()+i);const ds=d.toISOString().slice(0,10);return Math.max(0,...wTrips.filter(t=>t.date===ds).map(t=>t.maxSpeed));});
      const dailyOverEvents=dl.map((_,i)=>{const d=new Date(monday);d.setDate(d.getDate()+i);const c=wAlerts.filter((a:AlertRecord)=>a.type==="alert"&&new Date(a.timestamp).toDateString()===d.toDateString()).length;return c;});
      allReports.push({weekStart:monday.toISOString(),weekEnd:sunday.toISOString(),totalDistance:tDist,totalTime:tTime,totalTrips:wTrips.length,maxSpeed:mSpd,safetyScore:sPct,dailyMaxSpeeds,dailyOverEvents});
    }
    // Sort by week descending (most recent first)
    allReports.sort((a,b)=>new Date(b.weekStart).getTime()-new Date(a.weekStart).getTime());
    setWeeklyReports(allReports);
  },[trips,alerts]);

  // ---- Watch driver (guardian mode) ----
  const startWatching=useCallback(async(code:string)=>{
    if(!code.trim())return;
    const trimmedCode=code.trim().toUpperCase();
    if(trimmedCode.length!==6){setWatchError("Share code must be 6 characters.");return;}
    setWatchBusy(true);setWatchError("");setWatchedDriver(null);
    try{
      // Check network first
      const net=await NetInfo.fetch();
      if(!net.isConnected){setWatchError("No internet connection. Check your network.");setWatchBusy(false);return;}
      const{data,error}=await supabase.from("users").select("*").eq("short_id",trimmedCode).single();
      if(error){
        if(error.code==="PGRST116")setWatchError("No driver found with code "+trimmedCode+". Check the code and try again.");
        else if(error.message?.includes("Failed to fetch")||error.message?.includes("NetworkError"))setWatchError("Connection error. Check your internet and try again.");
        else setWatchError("Lookup failed: "+(error.message||"Unknown error"));
        setWatchBusy(false);return;
      }
      if(!data){setWatchError("No driver found with code "+trimmedCode+". Check the code and try again.");setWatchBusy(false);return;}
      setWatchedDriver(data);
      // Insert into watchers table so driver can send push notifications to this guardian
      if(userId){
        try{
          await supabase.from("watchers").upsert({
            driver_id:data.id,
            guardian_id:userId,
            guardian_push_token:pushToken,
            updated_at:new Date().toISOString()
          },{onConflict:"driver_id,guardian_id"});
          console.log("[SafeRide] Watcher registered for driver:",data.id);
        }catch(e){console.warn("[SafeRide] Watcher insert failed:",e);}
      }
      const sub=supabase.channel("watch-"+data.id)
        .on("postgres_changes",{event:"UPDATE",schema:"public",table:"users",filter:"id=eq."+data.id},(payload)=>{
          setWatchedDriver((prev:any)=>({...prev,...payload.new}));
          // Detect tracking start/stop for in-app notification
          const wasTracking=watchedDriverTrackingRef.current;
          const isTracking=!!payload.new.tracking_active;
          watchedDriverTrackingRef.current=isTracking;
          if(!wasTracking&&isTracking){
            addInAppNotif("Driver Started Tracking",`${data.name||"Driver"} is now sharing their live location.`,"#22c55e","play");
          }
          if(wasTracking&&!isTracking){
            addInAppNotif("Driver Stopped Tracking",`${data.name||"Driver"} has stopped sharing their location.`,"#ef4444","square");
          }
        })
        .on("postgres_changes",{event:"INSERT",schema:"public",table:"alerts",filter:"user_id=eq."+data.id},(payload)=>{
          const r=payload.new;
          const rec:AlertRecord={id:r.id,type:r.type,speed:Number(r.speed||0),location:r.location||"Unknown location",timestamp:new Date(r.timestamp).getTime(),lat:r.lat,lng:r.lng};
          setWatchedAlerts((prev:AlertRecord[])=>[rec,...prev.filter((x:AlertRecord)=>x.id!==rec.id)]);
          // Show in-app banner for overspeed alerts
          if(r.type==="alert"){
            addInAppNotif("Speed Alert!",`${data.name||"Driver"} is going ${r.speed} km/h — above the limit!`,"#ef4444","alert-triangle");
          }
        })
        .subscribe();
      setWatchSub(sub);
      // Load the watched driver's historical alerts
      setWatchedAlerts([]);
      try{
        const{data:driverAlerts}=await supabase.from("alerts").select("*").eq("user_id",data.id).order("timestamp",{ascending:false}).limit(200);
        if(driverAlerts)setWatchedAlerts(driverAlerts.map((r:any)=>({id:r.id,type:r.type,speed:Number(r.speed||0),location:r.location||"Unknown location",timestamp:new Date(r.timestamp).getTime(),lat:r.lat,lng:r.lng})));
      }catch(e){}
    }catch(e:any){
      const msg=e?.message||"";
      if(msg.includes("Failed to fetch")||msg.includes("NetworkError")||msg.includes("network"))setWatchError("Connection error. Check your internet and try again.");
      else setWatchError("Error: "+(msg||"Something went wrong. Try again."));
    }
    setWatchBusy(false);
  },[userId,pushToken]);

  const stopWatching=useCallback(async()=>{
    if(watchSub){supabase.removeChannel(watchSub);setWatchSub(null);}
    // Remove watcher entry
    if(watchedDriver?.id&&userId){
      try{await supabase.from("watchers").delete().eq("driver_id",watchedDriver.id).eq("guardian_id",userId);}catch(_e){}
    }
    setWatchedDriver(null);setWatchCodeInput("");setWatchError("");setWatchedTrips([]);setWatchedAlerts([]);
  },[watchSub,watchedDriver?.id,userId]);

  // ---- Load watched driver's trips ----
  useEffect(()=>{
    if(!watchedDriver?.id){setWatchedTrips([]);return;}
    const loadDriverTrips=async()=>{
      try{
        const{data}=await supabase.from("trips").select("*").eq("user_id",watchedDriver.id).order("created_at",{ascending:false}).limit(100);
        if(data)setWatchedTrips(data.map((t:any)=>({id:t.id,date:t.date?new Date(t.date).toISOString().slice(0,10):"",points:t.points||[],distanceKm:t.distance_km||0,durationSec:t.duration_sec||0,maxSpeed:t.max_speed||0,avgSpeed:t.avg_speed||0,alertsCount:t.alerts_count||0,startedAt:t.started_at?new Date(t.started_at).getTime():0,endedAt:t.ended_at?new Date(t.ended_at).getTime():0,trackingStatus:t.tracking_status||"completed",startLocation:t.start_location||"",endLocation:t.end_location||"",guardianNotified:t.guardian_notified||false})));
      }catch(e){}
    };
    loadDriverTrips();
    const interval=setInterval(loadDriverTrips,10000);
    return()=>clearInterval(interval);
  },[watchedDriver?.id]);

  // ---- Poll watched driver location every 3 seconds (fallback alongside Realtime) ----
  useEffect(()=>{
    if(!watchedDriver?.id)return;
    const driverId=watchedDriver.id;
    const poll=async()=>{
      try{
        const{data}=await supabase.from("users").select("latest_location,speed,status,route_points,updated_at,tracking_active").eq("id",driverId).single();
        if(data)setWatchedDriver((prev:any)=>({...prev,...data}));
      }catch(e){}
    };
    poll();
    const interval=setInterval(poll,3000);
    return()=>clearInterval(interval);
  },[watchedDriver?.id]);

  // ---- Start/Stop tracking ----
  const startTracking=useCallback(async()=>{
    try{
      const{status:perm}=await Location.requestForegroundPermissionsAsync();
      if(perm!=="granted"){Alert.alert("Permission needed","Location permission is required.");return;}
      try{await Location.requestBackgroundPermissionsAsync();}catch(e){}
      // Warn if running in Expo Go — background tracking won't work
      if(isExpoGo&&Platform.OS==="android"){
        const proceed=await new Promise<boolean>((resolve)=>{
          Alert.alert("Background Tracking Unavailable","You're running in Expo Go. Background tracking (screen off) requires a dev build.\n\nForeground tracking will work, but location sharing stops if you close the app.\n\nTo enable background tracking, run: expo run:android",[
            {text:"Start Anyway",onPress:()=>resolve(true)},
            {text:"Cancel",style:"cancel",onPress:()=>resolve(false)},
          ]);
        });
        if(!proceed)return;
      }
      setIsTracking(true);
      setRoutePoints([]);setTotalDistKm(0);setElapsedSec(0);setSpeed(0);setStatus("SAFE");
      sessionAlertsRef.current=[];
      trackingStartTimeRef.current=Date.now();
      AsyncStorage.setItem("bg_startTime",trackingStartTimeRef.current.toString()).catch(()=>{});
      const loc=await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.High});
      const newLoc={lat:loc.coords.latitude,lng:loc.coords.longitude};
      locationRef.current=newLoc;
      setLocation(newLoc);
      // Notify guardians that tracking started
      if(supabaseReadyRef.current&&userIdRef.current){
        addInAppNotif("Tracking Started","You are now sharing your location.","#22c55e","play");
        scheduleLocalNotif("Tracking Started","You are now sharing your live location with your guardian.");
        notifyGuardiansTrackingStarted(userIdRef.current,userName||"Driver").catch(()=>{});
      }
    }catch(e){Alert.alert("Error","Could not start tracking.");}
  },[userName,addInAppNotif,scheduleLocalNotif]);

  const stopTracking=useCallback(async()=>{
    setIsTracking(false);
    if(watchSubRef.current){watchSubRef.current.remove();watchSubRef.current=null;}
    stopBackgroundLocation();
    if(bgIntervalRef.current){clearInterval(bgIntervalRef.current);bgIntervalRef.current=null;}
    if(fgPushRef.current){clearInterval(fgPushRef.current);fgPushRef.current=null;}
    // Mark tracking inactive in Supabase
    const uid=userIdRef.current;
    if(supabaseReadyRef.current&&uid){
      try{await supabase.from("users").update({tracking_active:false,updated_at:new Date().toISOString()}).eq("id",uid);}catch(e){}
    }
    // Use refs for latest values (avoids stale closures)
    const pts=routePointsRef.current;
    const elapsed=elapsedSecRef.current;
    const dist=totalDistKmRef.current;
    const al=sessionAlertsRef.current;
    const supReady=supabaseReadyRef.current;
    const spd=speedRef.current;
    const startTime=trackingStartTimeRef.current||Date.now()-elapsed*1000;
    console.log("[SafeRide] Stopping tracking. Points:",pts.length,"Duration:",Math.round(elapsed/60),"min","Supabase:",supReady,"UserId:",uid);
    if(supReady&&uid&&pts.length>1){
      try{
        const startLoc=await reverseGeocode(pts[0].lat,pts[0].lng);
        const endLoc=await reverseGeocode(pts[pts.length-1].lat,pts[pts.length-1].lng);
        const{error:tripErr}=await supabase.from("trips").insert({user_id:uid,date:new Date().toISOString().slice(0,10),points:pts,distance_km:dist,duration_sec:elapsed,max_speed:Math.max(0,...al.map(a=>a.speed),spd),avg_speed:spd,alerts_count:al.length,started_at:new Date(startTime).toISOString(),ended_at:new Date().toISOString(),tracking_status:"completed",start_location:startLoc,end_location:endLoc,guardian_notified:false});
        if(tripErr)console.warn("[SafeRide] Trip save error:",tripErr.message);
        else{console.log("[SafeRide] Trip saved with",pts.length,"points,",startLoc,"→",endLoc);if(loadTripsRef.current)await loadTripsRef.current();}
      }catch(e){console.warn("Save trip error",e);}
    }
    setRoutePoints([]);setTotalDistKm(0);setElapsedSec(0);setSpeed(0);
    sessionAlertsRef.current=[];
    // Notify guardians that tracking stopped
    if(supReady&&uid){
      addInAppNotif("Tracking Stopped","You are no longer sharing your location.","#ef4444","square");
      scheduleLocalNotif("Tracking Stopped","You are no longer sharing your live location.");
      notifyGuardiansTrackingStopped(uid,userName||"Driver").catch(()=>{});
    }
  },[reverseGeocode,userName,addInAppNotif,scheduleLocalNotif]);

  // ---- Tab config ----
  const tabs=useMemo(()=>{
    if(userRole==="guardian")return[{id:"home",icon:"home",label:"Home"},{id:"alerts",icon:"bell",label:"Alerts"},{id:"history",icon:"clock",label:"History"},{id:"report",icon:"bar-chart-2",label:"Report"},{id:"share",icon:"share-2",label:"Share"}];
    return[{id:"home",icon:"home",label:"Home"},{id:"alerts",icon:"bell",label:"Alerts"},{id:"history",icon:"clock",label:"History"},{id:"report",icon:"bar-chart-2",label:"Report"},{id:"share",icon:"share-2",label:"Share"}];
  },[userRole]);

  if(initLoading)return(<SafeAreaView style={styles.container}><View style={{flex:1,alignItems:"center",justifyContent:"center"}}><View style={{width:72,height:72,borderRadius:18,backgroundColor:green,alignItems:"center",justifyContent:"center",marginBottom:16}}><Text style={{fontWeight:"900",color:"#05300f",fontSize:26}}>SR</Text></View><Text style={{color:white,fontWeight:"900",fontSize:30,marginBottom:8}}>SafeRide</Text></View></SafeAreaView>);
  if(!setupDone)return(<SafeAreaView style={styles.container}><LoginScreen onLogin={(user:AuthUser)=>{setAuthUser(user);setSetupDone(true);setUserName(user.name);setUserRole(user.role);setUserId(user.id);setShortId(user.shortId);}} supabaseReady={supabaseReady}/></SafeAreaView>);

  const handleSignOut=()=>{Alert.alert("Sign Out","Are you sure you want to sign out?",[{text:"Cancel",style:"cancel"},{text:"Sign Out",style:"destructive",onPress:async()=>{setIsTracking(false);if(watchSubRef.current){watchSubRef.current.remove();watchSubRef.current=null;}if(bgIntervalRef.current){clearInterval(bgIntervalRef.current);bgIntervalRef.current=null;}if(fgPushRef.current){clearInterval(fgPushRef.current);fgPushRef.current=null;}await stopBackgroundLocation();await authSignOut();await AsyncStorage.clear();setAuthUser(null);setSetupDone(false);setUserName("");setUserRole("driver");setUserId("");setShortId("");setRoutePoints([]);setTotalDistKm(0);setElapsedSec(0);setAlerts([]);setTrips([]);}}]);};

  return(
    <SafeAreaView style={styles.container}>
      <StatusBar style="light"/>
      <InAppBanner notifs={inAppNotifs} dismiss={(id)=>setInAppNotifs(prev=>prev.filter(n=>n.id!==id))}/>
      <View style={{flex:1}}>
        {activeTab==="home"&&userRole==="guardian"&&<ShareScreen userId={userId} shortId={shortId} userName={userName} userRole={userRole} isTracking={isTracking} latestLocation={location} speed={speed} status={status} supabaseReady={supabaseReady} pushToken={pushToken} notificationsReady={notificationsReady} watchCodeInput={watchCodeInput} setWatchCodeInput={setWatchCodeInput} watchedDriver={watchedDriver} watchError={watchError} watchBusy={watchBusy} startWatching={startWatching} stopWatching={stopWatching}/>}
        {activeTab==="home"&&userRole==="driver"&&<HomeScreen tracking={{isTracking,toggle:startTracking,speed,status,coords:location,route:routePoints,distanceKm:totalDistKm,durationSec:elapsedSec}} driverName={userName} onSignOut={handleSignOut} onStartTracking={startTracking} onStopTracking={stopTracking}/>}
        {activeTab==="alerts"&&<AlertsScreen alerts={watchedDriver?watchedAlerts:alerts} watchedName={watchedDriver?.name||userName}/>}
        {activeTab==="history"&&<HistoryScreen trips={watchedDriver?watchedTrips:trips} liveRoute={watchedDriver?(Array.isArray(watchedDriver.route_points)?watchedDriver.route_points:[]):routePoints} isTracking={watchedDriver?!!watchedDriver.tracking_active:isTracking} watchedName={watchedDriver?.name||""} elapsedSecLive={watchedDriver?(Array.isArray(watchedDriver.route_points)?Math.max(0,(watchedDriver.route_points.length-1)*5):0):elapsedSec}/>}
        {activeTab==="report"&&<ReportScreen trips={watchedDriver?watchedTrips:trips} alerts={watchedDriver?watchedAlerts:alerts} watchedName={watchedDriver?.name||""}/>}
        {activeTab==="share"&&<ShareScreen userId={userId} shortId={shortId} userName={userName} userRole={userRole} isTracking={isTracking} latestLocation={location} speed={speed} status={status} supabaseReady={supabaseReady} pushToken={pushToken} notificationsReady={notificationsReady} watchCodeInput={watchCodeInput} setWatchCodeInput={setWatchCodeInput} watchedDriver={watchedDriver} watchError={watchError} watchBusy={watchBusy} startWatching={startWatching} stopWatching={stopWatching}/>}
      </View>
      <BottomNav tabs={tabs} active={activeTab} onChange={setActiveTab}/>
    </SafeAreaView>
  );
}

// ===== STYLES =====
const styles=StyleSheet.create({
  container:{flex:1,backgroundColor:bg},
  header:{flexDirection:"row",alignItems:"center",paddingHorizontal:16,paddingVertical:12,borderBottomWidth:1,borderBottomColor:border},
  logoBox:{width:32,height:32,borderRadius:8,backgroundColor:green,alignItems:"center",justifyContent:"center",marginRight:10},
  pill:{backgroundColor:"rgba(255,255,255,0.06)",borderRadius:20,paddingHorizontal:12,paddingVertical:6,alignItems:"center",justifyContent:"center"},
  card:{backgroundColor:cardBg,borderRadius:12,padding:14,borderWidth:1,borderColor:border},
  labelSm:{fontSize:10,fontWeight:"700",color:muted,textTransform:"uppercase",letterSpacing:0.5},
  input:{backgroundColor:cardBg2,color:white,borderRadius:10,padding:12,borderWidth:1,borderColor:border,fontSize:14},
  btnPrimary:{backgroundColor:green,borderRadius:12,paddingVertical:14,alignItems:"center",justifyContent:"center"},
  btnSecondary:{backgroundColor:"rgba(255,255,255,0.06)",borderRadius:12,paddingVertical:14,alignItems:"center",justifyContent:"center",borderWidth:1,borderColor:border},
  speedRing:{width:140,height:140,borderRadius:70,alignItems:"center",justifyContent:"center"},
  speedNum:{fontSize:44,fontWeight:"900",color:white},
  mapWrap:{borderRadius:12,overflow:"hidden",borderWidth:1,borderColor:border},
  label:{fontSize:10,fontWeight:"700",color:muted,textTransform:"uppercase",letterSpacing:0.5},
  headerRow:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",paddingHorizontal:16,paddingVertical:12,borderBottomWidth:1,borderBottomColor:border},
  bottomNav:{flexDirection:"row",justifyContent:"space-around",alignItems:"center",paddingVertical:8,paddingBottom:12,backgroundColor:cardBg,borderTopWidth:1,borderTopColor:border},
  navItem:{alignItems:"center",justifyContent:"center",paddingHorizontal:12,paddingVertical:6,borderRadius:10},

});
