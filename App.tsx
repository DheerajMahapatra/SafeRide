import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, TextInput, Alert, Platform } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Feather } from "@expo/vector-icons";
import Svg, { Circle } from "react-native-svg";
import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";

// ---------- SUPABASE ----------
import { supabase } from "./supabase";

// ---------- THEME ----------
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
const SPEED_LIMIT = 60;
// Once OVERSPEED fires above the limit, the driver must drop this far below
// it before the status flips back to SAFE - prevents alert flapping from
// GPS jitter right around 60 km/h.
const SAFE_BUFFER_KMH = 5;
// Stationary GPS reports phantom speeds of 0-3 km/h (satellite drift).
// Anything below this is treated as standing still.
const MIN_MOVING_KMH = 4;

// ---------- LIVE MAP (WebView + Leaflet + dark CARTO/OSM tiles) ----------
// Renders on EVERY device: no Google Play Services required, no API key,
// no black-screen failure mode. Dark theme matches the app. Supports live
// marker(s) + route polyline and follows the latest point automatically.
const LEAFLET_HTML = `
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#m{height:100%;margin:0;background:#0b111a}
.leaflet-control-attribution{font-size:8px;opacity:.6}</style>
</head><body><div id="m"></div><script>
var map=L.map('m',{zoomControl:false}).setView([20.5937,78.9629],12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
 {maxZoom:19,subdomains:'abcd',attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(map);
var marker=null,line=null;
function render(raw){
  try{
    var d=JSON.parse(raw);
    var pts=(d.points||[]).map(function(p){return [p.lat,p.lng];});
    if(line){line.setLatLngs(pts);}
    else if(pts.length>1){line=L.polyline(pts,{color:'#22c55e',weight:4,opacity:.9}).addTo(map);}
    var pin=d.pins&&d.pins[0];
    if(pin&&pin.lat!=null){
      var ll=[pin.lat,pin.lng];
      if(marker){marker.setLatLng(ll);}
      else{marker=L.circleMarker(ll,{radius:8,color:'#ffffff',weight:2,fillColor:pin.color||'#22c55e',fillOpacity:1}).addTo(map);}
      map.setView(ll,15,{animate:true,duration:0.5});
    }
  }catch(e){}
}
document.addEventListener('message',function(e){render(e.data);});
window.addEventListener('message',function(e){render(e.data);});
</script></body></html>`;

function LiveMap({
  lat,
  lng,
  points = [],
  pins = [],
  height = 220,
}: {
  lat?: number;
  lng?: number;
  points?: { lat: number; lng: number }[];
  pins?: { lat: number; lng: number; color: string }[];
  height?: number;
}) {
  const webRef = useRef<any>(null);
  const hasFix = typeof lat === "number" && typeof lng === "number";

  const payload = React.useMemo(
    () =>
      JSON.stringify({
        lat: lat ?? 20.5937,
        lng: lng ?? 78.9629,
        points: points.slice(-100),
        pins: pins.length ? pins : hasFix ? [{ lat, lng, color: green }] : [],
      }),
    [lat, lng, points, pins, hasFix]
  );

  // Push fresh data into the page whenever it changes, and once after load.
  useEffect(() => {
    if (webRef.current) webRef.current.postMessage(payload);
  }, [payload]);

  return (
    <View style={{ height, borderRadius: 12, overflow: "hidden", backgroundColor: "#0b111a" }}>
      <WebView
        ref={webRef}
        source={{ html: LEAFLET_HTML }}
        style={{ flex: 1, backgroundColor: "#0b111a" }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        cacheEnabled
        onLoadEnd={() => {
          if (webRef.current) webRef.current.postMessage(payload);
        }}
      />
      {!hasFix && (
        <View pointerEvents="none" style={{ position: "absolute", top: 10, left: 10 }}>
          <View style={[styles.pill, { backgroundColor: "rgba(0,0,0,0.6)", paddingVertical: 3 }]}>
            <Text style={{ color: white, fontSize: 10, fontWeight: "700" }}>Waiting for location…</Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ---------- HELPERS ----------
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function computeRouteDistanceKm(points: { lat: number; lng: number }[]) {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += haversineKm(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return d;
}
function mondayOf(d: Date) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function fmtHM(mins: number) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type TripPoint = { lat: number; lng: number; speed: number; timestamp: number };
type Trip = { id: string; date: string; points: TripPoint[]; distanceKm: number; durationMin: number; maxSpeed: number };
type AlertRecord = { id: string; type: "alert" | "normal"; speed: number; location: string; timestamp: number };
type WeeklyReport = {
  weekStart: string;
  weekEnd: string;
  totalDistance: number;
  totalTime: number;
  totalTrips: number;
  maxSpeed: number;
  safetyScore: number;
  dailyMaxSpeeds: number[];
  dailyOverEvents: number[];
};

async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
async function saveJSON(key: string, value: any) {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

// Generate a local device identity. No login, no server round-trip -
// this id is just a permanent random name-tag for this phone.
function generateLocalId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Send a real push notification straight to another phone via Expo's
// push service (no backend server needed - the driver's app calls this
// directly whenever it needs to alert a guardian's phone).
async function sendExpoPush(tokens: string[], title: string, body: string, data?: any) {
  const validTokens = tokens.filter((t) => !!t && t.startsWith("ExponentPushToken"));
  if (validTokens.length === 0) return;
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(
        validTokens.map((to) => ({ to, sound: "default", title, body, data, priority: "high" }))
      ),
    });
  } catch (e) {
    console.warn("Expo push send failed:", e);
  }
}

// ---------- UI COMPONENTS ----------
function Pill({ children, style }: any) {
  return <View style={[styles.pill, style]}>{children}</View>;
}
function BottomNav({ active, setActive }: any) {
  const items = [
    { key: "home", label: "Home", icon: "home" },
    { key: "alerts", label: "Alerts", icon: "bell" },
    { key: "history", label: "History", icon: "clock" },
    { key: "report", label: "Report", icon: "bar-chart-2" },
    { key: "share", label: "Share", icon: "share-2" },
  ];
  return (
    <View style={styles.bottomNav}>
      {items.map(({ key, label, icon }) => {
        const isActive = active === key;
        return (
          <Pressable key={key} onPress={() => setActive(key)} style={[styles.navItem, isActive && { borderColor: green, borderWidth: 1 }]}>
            <Feather name={icon as any} size={20} color={isActive ? green : muted} />
            <Text style={{ fontSize: 11, fontWeight: "700", color: isActive ? green : muted, marginTop: 2 }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------- WATCHED DRIVER LIVE CARD (guardian home) ----------
function WatchedDriverCard({ driver }: { driver: any }) {
  const loc = driver?.latest_location || null;
  const over = driver?.status === "OVERSPEED";
  const updatedAtMs = driver?.updated_at ? new Date(driver.updated_at).getTime() : 0;
  const stale = !loc || Date.now() - updatedAtMs > 25000;
  const pts: any[] = Array.isArray(driver?.route_points) ? driver.route_points : [];
  const distKm = computeRouteDistanceKm(pts);
  const lastSeen = updatedAtMs
    ? new Date(updatedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <View style={{ paddingHorizontal: 16, marginTop: 2 }}>
      <View style={[styles.card, { borderLeftWidth: 4, borderLeftColor: stale ? muted : over ? red : green }]}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {!stale && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: green }} />}
            <Text style={{ color: white, fontWeight: "800", fontSize: 15 }}>
              {stale ? "Signal lost" : "LIVE"} · {driver?.name || "Driver"}
            </Text>
          </View>
          <View style={[styles.pill, { backgroundColor: stale ? "rgba(107,122,143,0.18)" : over ? "rgba(239,68,68,0.18)" : "rgba(34,197,94,0.18)", paddingVertical: 3, paddingHorizontal: 8 }]}>
            <Text style={{ color: stale ? muted : over ? redBright : green, fontSize: 10, fontWeight: "700" }}>
              {stale ? "OFFLINE" : over ? "OVERSPEED" : "SAFE"}
            </Text>
          </View>
        </View>

        <View style={{ marginTop: 10 }}>
          {loc ? (
            <LiveMap lat={loc.lat} lng={loc.lng} points={pts} pins={[{ lat: loc.lat, lng: loc.lng, color: over ? red : green }]} height={210} />
          ) : (
            <View style={{ height: 210, borderRadius: 12, backgroundColor: "#0b111a", alignItems: "center", justifyContent: "center" }}>
              <Feather name="radio" size={20} color={muted} />
              <Text style={{ color: muted, fontSize: 12, marginTop: 6, textAlign: "center" }}>
                Waiting for the driver to start sharing…{"\n"}(driver must tap Start on their phone)
              </Text>
            </View>
          )}
          {!stale && loc && (
            <View style={{ position: "absolute", top: 20, left: 20, flexDirection: "row", gap: 8 }}>
              <View style={[styles.pill, { backgroundColor: "rgba(34,197,94,0.85)", flexDirection: "row", gap: 5, alignItems: "center", paddingVertical: 3 }]}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#05300f" }} />
                <Text style={{ color: "#05300f", fontSize: 11, fontWeight: "800" }}>LIVE</Text>
              </View>
              {over && (
                <View style={[styles.pill, { backgroundColor: "rgba(239,68,68,0.92)", paddingVertical: 3 }]}>
                  <Text style={{ color: white, fontSize: 11, fontWeight: "800" }}>OVERSPEEDING</Text>
                </View>
              )}
            </View>
          )}
        </View>

        <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
          <View style={[styles.card, { flex: 1.2, backgroundColor: cardBg2 }]}>
            <Text style={styles.labelSm}>SPEED</Text>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
              <Text style={{ fontSize: 26, fontWeight: "800", color: stale ? muted : over ? redBright : greenBright }}>{Math.round(driver?.speed || 0)}</Text>
              <Text style={{ fontSize: 11, color: muted, fontWeight: "600" }}>km/h</Text>
            </View>
          </View>
          <View style={[styles.card, { flex: 1, backgroundColor: cardBg2 }]}>
            <Text style={styles.labelSm}>TRIP DIST</Text>
            <Text style={{ fontSize: 22, fontWeight: "800", color: white, marginTop: 4 }}>{distKm.toFixed(1)}</Text>
            <Text style={{ fontSize: 10, color: muted, fontWeight: "700" }}>KM</Text>
          </View>
          <View style={[styles.card, { flex: 1, backgroundColor: cardBg2 }]}>
            <Text style={styles.labelSm}>UPDATED</Text>
            <Text style={{ fontSize: 13, fontWeight: "800", color: white, marginTop: 8 }}>{lastSeen}</Text>
          </View>
        </View>

        {!!loc && stale && (
          <Text style={{ color: muted, fontSize: 11, marginTop: 8 }}>
            No update for a while — the driver may have stopped tracking or lost signal.
          </Text>
        )}
      </View>
    </View>
  );
}

// ---------- HOME ----------
function HomeScreen({ tracking, driverName, watched }: any) {
  const { isTracking, toggle, speed, status, coords, route, distanceKm, durationMin, locationName } = tracking;

  return (
    <View>
      <View style={styles.headerRow}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={styles.logoBox}><Text style={{ fontWeight: "800", color: "#05300f", fontSize: 13 }}>SR</Text></View>
          <View>
            <Text style={{ color: white, fontWeight: "700", fontSize: 15 }}>SafeRide</Text>
            {(isTracking || !!watched) && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 1 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: watched && !isTracking ? "#3b82f6" : green }} />
                <Text style={{ fontSize: 10, fontWeight: "700", color: watched && !isTracking ? "#3b82f6" : green }}>
                  {watched && !isTracking ? "WATCHING DRIVER" : "TRACKING ON"}
                </Text>
              </View>
            )}
          </View>
        </View>
        <Pressable onPress={toggle} style={[styles.pill, { backgroundColor: isTracking ? "rgba(239,68,68,0.18)" : green }]}>
          <Text style={{ color: isTracking ? redBright : "#05300f", fontWeight: "700", fontSize: 12 }}>
            {isTracking ? "Stop" : "Start"}
          </Text>
        </Pressable>
      </View>

      {watched && <WatchedDriverCard driver={watched} />}

      <View style={{ paddingHorizontal: 16, marginTop: watched ? 12 : 0 }}>
        <View style={{ position: "relative" }}>
          {coords ? (
            <>
              <LiveMap lat={coords.lat} lng={coords.lng} points={route} pins={[{ lat: coords.lat, lng: coords.lng, color: green }]} height={300} />
              {isTracking && (
                <View style={{ position: "absolute", top: 10, left: 10, flexDirection: "row", gap: 8 }}>
                  <View style={[styles.pill, { backgroundColor: "rgba(34,197,94,0.85)", flexDirection: "row", gap: 5, alignItems: "center" }]}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#05300f" }} />
                    <Text style={{ color: "#05300f", fontSize: 11, fontWeight: "800" }}>LIVE</Text>
                  </View>
                  <View style={[styles.pill, { backgroundColor: "rgba(0,0,0,0.55)", flexDirection: "row", gap: 5, alignItems: "center" }]}>
                    <Feather name="map-pin" size={11} color={white} />
                    <Text style={{ color: white, fontSize: 11, fontWeight: "600" }}>{driverName || "Driver"} is travelling</Text>
                  </View>
                </View>
              )}
            </>
          ) : (
            <View style={{ height: 300, borderRadius: 12, backgroundColor: "#0b111a", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: muted, fontSize: 12 }}>Waiting for GPS…{"\n"}Tap Start to begin tracking</Text>
            </View>
          )}
        </View>
      </View>

      {isTracking && (
        <>
          <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, marginTop: 12 }}>
            <View style={[styles.card, { flex: 1.4 }]}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={styles.label}>CURRENT SPEED</Text>
                <View style={[styles.pill, { backgroundColor: status === "SAFE" ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.18)", paddingVertical: 3, paddingHorizontal: 8 }]}>
                  <Text style={{ color: status === "SAFE" ? green : redBright, fontSize: 10, fontWeight: "700" }}>{status}</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 6 }}>
                <Text style={{ fontSize: 44, fontWeight: "800", color: status === "SAFE" ? greenBright : redBright }}>{speed}</Text>
                <Text style={{ fontSize: 13, color: muted, fontWeight: "600" }}>km/h</Text>
              </View>
              <View style={{ borderTopWidth: 1, borderTopColor: border, marginTop: 12, paddingTop: 10, flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 11, color: muted }}>Speed Limit</Text>
                <Text style={{ fontSize: 12, color: white, fontWeight: "700" }}>{SPEED_LIMIT} km/h</Text>
              </View>
            </View>
            <View style={{ flex: 1, gap: 10 }}>
              <View style={[styles.card, { flex: 1 }]}>
                <Text style={styles.labelSm}>DISTANCE</Text>
                <Text style={{ fontSize: 22, fontWeight: "800", color: white, marginTop: 6 }}>{distanceKm.toFixed(1)}</Text>
                <Text style={{ fontSize: 10, color: muted, fontWeight: "700" }}>KM</Text>
              </View>
              <View style={[styles.card, { flex: 1 }]}>
                <Text style={styles.labelSm}>DURATION</Text>
                <Text style={{ fontSize: 22, fontWeight: "800", color: white, marginTop: 6 }}>{durationMin}</Text>
                <Text style={{ fontSize: 10, color: muted, fontWeight: "700" }}>min</Text>
              </View>
            </View>
          </View>
          <View style={[styles.card, { backgroundColor: cardBg2, marginHorizontal: 16, marginTop: 10, flexDirection: "row", justifyContent: "space-between" }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Feather name="map-pin" size={12} color={muted} />
              <Text style={{ color: white, fontSize: 12 }}>{locationName}</Text>
            </View>
            <Text style={{ color: muted, fontSize: 11 }}>{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
          </View>
        </>
      )}

      {!isTracking && (
        <View style={{ paddingHorizontal: 16, marginTop: 14 }}>
          <Text style={{ color: muted, fontSize: 12, textAlign: "center" }}>
            Tracking is off. Tap "Start" above to begin sharing live location and speed.
          </Text>
        </View>
      )}
    </View>
  );
}

// ---------- ALERTS ----------
function AlertsScreen({ alerts, watchedName }: any) {
  const overCount = alerts.filter((a: AlertRecord) => a.type === "alert").length;
  const safeCount = alerts.filter((a: AlertRecord) => a.type === "normal").length;
  return (
    <View style={{ paddingHorizontal: 16 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <View>
          <Text style={{ color: white, fontWeight: "800", fontSize: 22 }}>Alerts</Text>
          <Text style={{ color: muted, fontSize: 12, marginTop: 2 }}>
            {watchedName ? `${watchedName}'s activity · ${new Date().toDateString()}` : `Today · ${new Date().toDateString()}`}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ backgroundColor: "rgba(239,68,68,0.15)", borderRadius: 10, paddingVertical: 6, paddingHorizontal: 12, alignItems: "center" }}>
            <Text style={{ color: redBright, fontWeight: "800", fontSize: 16 }}>{overCount}</Text>
            <Text style={{ color: redBright, fontSize: 8, fontWeight: "700" }}>OVER</Text>
          </View>
          <View style={{ backgroundColor: "rgba(34,197,94,0.15)", borderRadius: 10, paddingVertical: 6, paddingHorizontal: 12, alignItems: "center" }}>
            <Text style={{ color: greenBright, fontWeight: "800", fontSize: 16 }}>{safeCount}</Text>
            <Text style={{ color: greenBright, fontSize: 8, fontWeight: "700" }}>SAFE</Text>
          </View>
        </View>
      </View>

      {alerts.length === 0 ? (
        <View style={{ marginTop: 40, alignItems: "center" }}>
          <Feather name="bell-off" size={22} color={muted} />
          <Text style={{ color: muted, fontSize: 13, marginTop: 8 }}>No alerts today</Text>
        </View>
      ) : (
        <View style={{ marginTop: 16 }}>
          {alerts.map((a: AlertRecord) => {
            const isAlert = a.type === "alert";
            const color = isAlert ? red : green;
            const bright = isAlert ? redBright : greenBright;
            return (
              <View key={a.id} style={{ flexDirection: "row", gap: 14, marginBottom: 14 }}>
                <View style={{ width: 10, alignItems: "center" }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color, marginTop: 18 }} />
                </View>
                <View style={[styles.card, { flex: 1, borderLeftWidth: 3, borderLeftColor: color }]}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <View style={[styles.pill, { backgroundColor: isAlert ? "rgba(239,68,68,0.18)" : "rgba(34,197,94,0.18)", flexDirection: "row", gap: 5, paddingVertical: 3, paddingHorizontal: 9 }]}>
                      <Feather name={isAlert ? "alert-triangle" : "check"} size={10} color={bright} />
                      <Text style={{ color: bright, fontSize: 10, fontWeight: "700" }}>{isAlert ? "SPEED ALERT" : "SPEED NORMAL"}</Text>
                    </View>
                    <Text style={{ fontSize: 10, color: muted }}>{new Date(a.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
                  </View>
                  <View style={{ marginTop: 8 }}>
                    <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                      <Text style={{ fontSize: 26, fontWeight: "800", color: bright }}>{a.speed}</Text>
                      <Text style={{ fontSize: 12, color: muted, marginLeft: 4 }}>km/h</Text>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
                      <Feather name="map-pin" size={10} color={muted} />
                      <Text style={{ fontSize: 11, color: muted }}>{a.location}</Text>
                    </View>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ---------- HISTORY ----------
function HistoryScreen({ trips, liveRoute, isTracking, watchedName }: any) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTrips: Trip[] = trips.filter((t: Trip) => t.date === todayStr);
  const liveOnly = isTracking && liveRoute.length > 1;
  const allPoints = liveOnly ? liveRoute : todayTrips.flatMap((t) => t.points);

  const distance = todayTrips.reduce((s, t) => s + t.distanceKm, 0);
  const duration = todayTrips.reduce((s, t) => s + t.durationMin, 0);
  const maxSpeed = Math.max(0, ...todayTrips.map((t) => t.maxSpeed));
  const stops = todayTrips.length;

  return (
    <View style={{ paddingHorizontal: 16 }}>
      <Text style={{ color: white, fontWeight: "800", fontSize: 22 }}>{watchedName ? `History · ${watchedName}` : "History"}</Text>
      <Text style={{ color: muted, fontSize: 12, marginTop: 2 }}>{new Date().toDateString()}</Text>

      <View style={{ marginTop: 12 }}>
        {allPoints.length > 0 ? (
          <LiveMap
            lat={allPoints[allPoints.length - 1].lat}
            lng={allPoints[allPoints.length - 1].lng}
            points={allPoints}
            pins={[
              { lat: allPoints[0].lat, lng: allPoints[0].lng, color: green },
              { lat: allPoints[allPoints.length - 1].lat, lng: allPoints[allPoints.length - 1].lng, color: red },
            ]}
            height={200}
          />
        ) : (
          <View style={{ height: 200, borderRadius: 12, backgroundColor: "#0b111a", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: muted, fontSize: 12 }}>No trips recorded yet today</Text>
          </View>
        )}
      </View>

      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
        {[["DISTANCE", `${distance.toFixed(1)} km`], ["DURATION", fmtHM(duration)], ["STOPS", `${stops}`], ["MAX", `${maxSpeed} km/h`]].map(([l, v]) => (
          <View key={l} style={{ alignItems: "center", flex: 1 }}>
            <Text style={{ fontSize: 8, color: muted, fontWeight: "700" }}>{l}</Text>
            <Text style={{ fontSize: 13, color: white, fontWeight: "800", marginTop: 2 }}>{v}</Text>
          </View>
        ))}
      </View>

      <Text style={{ fontSize: 11, color: muted, fontWeight: "700", marginTop: 18, marginBottom: 10 }}>JOURNEY TIMELINE</Text>

      {todayTrips.length === 0 ? (
        <Text style={{ color: muted, fontSize: 12, textAlign: "center", marginTop: 10 }}>No trips recorded</Text>
      ) : (
        todayTrips.map((t, i) => (
          <View key={t.id} style={{ flexDirection: "row", gap: 14, marginBottom: 14 }}>
            <View style={{ width: 10, alignItems: "center" }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: green, marginTop: 6 }} />
            </View>
            <View style={[styles.card, { flex: 1 }]}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: white, fontWeight: "700", fontSize: 13 }}>Trip {i + 1}</Text>
                <Text style={{ fontSize: 10, color: muted }}>{new Date(t.points[0]?.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
              </View>
              <Text style={{ fontSize: 11, color: muted, marginTop: 4 }}>{t.distanceKm.toFixed(1)} km · {fmtHM(t.durationMin)} · max {t.maxSpeed} km/h</Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

// ---------- REPORT ----------
function BarMini({ label, value }: any) {
  const over = value > SPEED_LIMIT;
  const h = value ? Math.min(56, (value / 90) * 56) : 4;
  return (
    <View style={{ alignItems: "center", gap: 4, flex: 1 }}>
      <Text style={{ fontSize: 9, fontWeight: "700", color: over ? redBright : greenBright }}>{value || "-"}</Text>
      <View style={{ height: 56, justifyContent: "flex-end" }}>
        <View style={{ width: 16, height: h, backgroundColor: over ? red : green, borderRadius: 4, opacity: value ? 0.9 : 0.25 }} />
      </View>
      <Text style={{ fontSize: 9, color: muted }}>{label}</Text>
    </View>
  );
}

function ReportScreen({ trips, alerts, weeklyReports, watchedName }: any) {
  const latestReport = weeklyReports.length > 0 ? weeklyReports[weeklyReports.length - 1] : null;

  if (latestReport) {
    const {
      weekStart,
      weekEnd,
      totalDistance,
      totalTime,
      totalTrips,
      maxSpeed,
      safetyScore,
      dailyMaxSpeeds,
      dailyOverEvents,
    } = latestReport;
    const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    return (
      <ScrollView style={{ paddingHorizontal: 16 }}>
        <Text style={{ color: white, fontWeight: "800", fontSize: 20 }}>{watchedName ? `${watchedName}'s Weekly Report` : "Weekly Report"}</Text>
        <Text style={{ color: muted, fontSize: 12, marginTop: 2 }}>
          {new Date(weekStart).toDateString()} – {new Date(weekEnd).toDateString()}
        </Text>
        <Text style={{ color: greenBright, fontSize: 10, marginTop: 4, fontWeight: "700" }}>✓ Final report (auto-generated)</Text>

        <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
          <View style={[styles.card, { flex: 1, alignItems: "center" }]}>
            <Text style={[styles.labelSm, { alignSelf: "flex-start" }]}>SAFETY SCORE</Text>
            <View style={{ width: 88, height: 88, marginTop: 8, marginBottom: 4 }}>
              <Svg width="88" height="88">
                <Circle cx="44" cy="44" r="36" stroke="rgba(255,255,255,0.1)" strokeWidth="7" fill="none" />
                <Circle cx="44" cy="44" r="36" stroke={green} strokeWidth="7" fill="none" strokeDasharray={`${2 * Math.PI * 36}`} strokeDashoffset={2 * Math.PI * 36 * (1 - safetyScore / 100)} strokeLinecap="round" rotation="-90" origin="44,44" />
              </Svg>
              <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 20, fontWeight: "800", color: white }}>{safetyScore}</Text>
                <Text style={{ fontSize: 9, color: muted }}>/100</Text>
              </View>
            </View>
          </View>
          <View style={[styles.card, { flex: 1 }]}>
            <Text style={[styles.labelSm, { marginBottom: 10 }]}>BEHAVIOR</Text>
            {[["Safe", safetyScore, green], ["Overspeed", 100 - safetyScore, red]].map(([l, v, c]: any) => (
              <View key={l} style={{ marginBottom: 10 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                  <Text style={{ fontSize: 11, color: white }}>{l}</Text>
                  <Text style={{ fontSize: 11, color: c, fontWeight: "700" }}>{v}%</Text>
                </View>
                <View style={{ height: 4, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 2 }}>
                  <View style={{ height: 4, width: `${v}%`, backgroundColor: c, borderRadius: 2 }} />
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
          {[
            ["TOTAL DISTANCE", `${totalDistance.toFixed(1)}`, "km"],
            ["TRAVEL TIME", fmtHM(totalTime), ""],
            ["TOTAL TRIPS", `${totalTrips}`, "trips"],
            ["MAX SPEED", `${maxSpeed}`, "km/h"],
          ].map(([l, v, u]) => (
            <View key={l} style={[styles.card, { width: "47%" }]}>
              <Text style={styles.labelSm}>{l}</Text>
              <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 4 }}>
                <Text style={{ fontSize: 18, fontWeight: "800", color: white }}>{v}</Text>
                {!!u && <Text style={{ fontSize: 11, color: muted, marginLeft: 4 }}>{u}</Text>}
              </View>
            </View>
          ))}
        </View>

        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={{ color: white, fontWeight: "700", fontSize: 13 }}>Max Speed Overview</Text>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 12 }}>
            {dayLabels.map((l, i) => <BarMini key={l} label={l} value={dailyMaxSpeeds[i]} />)}
          </View>
        </View>

        <View style={[styles.card, { marginTop: 10, marginBottom: 20 }]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ color: white, fontWeight: "700", fontSize: 13 }}>Overspeed Events</Text>
            <Pill style={{ backgroundColor: "rgba(239,68,68,0.18)" }}>
              <Text style={{ color: redBright, fontSize: 9, fontWeight: "700" }}>
                {dailyOverEvents.reduce((a: number, b: number) => a + b, 0)} THIS WEEK
              </Text>
            </Pill>
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 12 }}>
            {dayLabels.map((l, i) => (
              <View key={l} style={{ flex: 1, alignItems: "center" }}>
                <View style={{ height: 34, width: "100%", borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: dailyOverEvents[i] ? "rgba(239,68,68,0.22)" : "rgba(255,255,255,0.05)" }}>
                  <Text style={{ color: dailyOverEvents[i] ? redBright : muted, fontWeight: "700", fontSize: 12 }}>{dailyOverEvents[i] || "-"}</Text>
                </View>
                <Text style={{ fontSize: 9, color: muted, marginTop: 4 }}>{l}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    );
  }

  // Fallback to current week (live data)
  const monday = mondayOf(new Date());
  const weekTrips: Trip[] = trips.filter((t: Trip) => new Date(t.date) >= monday);
  const weekAlerts: AlertRecord[] = alerts.filter((a: AlertRecord) => new Date(a.timestamp) >= monday);

  if (weekTrips.length === 0) {
    return (
      <View style={{ paddingHorizontal: 16 }}>
        <Text style={{ color: white, fontWeight: "800", fontSize: 20 }}>{watchedName ? `${watchedName}'s Weekly Report` : "Weekly Report"}</Text>
        <Text style={{ color: muted, fontSize: 12, marginTop: 2 }}>
          {monday.toDateString()} – {new Date().toDateString()}
        </Text>
        <View style={{ marginTop: 60, alignItems: "center" }}>
          <Feather name="bar-chart-2" size={22} color={muted} />
          <Text style={{ color: muted, fontSize: 13, marginTop: 8, textAlign: "center" }}>
            Not enough data for weekly report{"\n"}Start tracking trips to build your report
          </Text>
        </View>
      </View>
    );
  }

  const totalDistance = weekTrips.reduce((s, t) => s + t.distanceKm, 0);
  const totalTime = weekTrips.reduce((s, t) => s + t.durationMin, 0);
  const maxSpeed = Math.max(0, ...weekTrips.map((t) => t.maxSpeed));
  const allPoints = weekTrips.flatMap((t) => t.points);
  const safePts = allPoints.filter((p) => p.speed <= SPEED_LIMIT).length;
  const safePct = allPoints.length ? Math.round((safePts / allPoints.length) * 100) : 100;
  const overPct = 100 - safePct;
  const overspeedEvents = weekAlerts.filter((a) => a.type === "alert").length;
  const circumference = 2 * Math.PI * 36;

  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const perDayMax = dayLabels.map((_, i) => {
    const day = new Date(monday);
    day.setDate(day.getDate() + i);
    const dayStr = day.toISOString().slice(0, 10);
    const dayTrips = weekTrips.filter((t) => t.date === dayStr);
    return Math.max(0, ...dayTrips.map((t) => t.maxSpeed));
  });
  const perDayOverEvents = dayLabels.map((_, i) => {
    const day = new Date(monday);
    day.setDate(day.getDate() + i);
    const count = weekAlerts.filter((a) => a.type === "alert" && new Date(a.timestamp).toDateString() === day.toDateString()).length;
    return count || null;
  });

  return (
    <ScrollView style={{ paddingHorizontal: 16 }}>
      <Text style={{ color: white, fontWeight: "800", fontSize: 20 }}>{watchedName ? `${watchedName}'s Weekly Report` : "Weekly Report"}</Text>
      <Text style={{ color: muted, fontSize: 12, marginTop: 2 }}>{monday.toDateString()} – {new Date().toDateString()}</Text>
      <Text style={{ color: muted, fontSize: 10, marginTop: 6 }}>Auto-calculated from your trips so far this week (updates live; final for the week once Sunday ends).</Text>

      <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
        <View style={[styles.card, { flex: 1, alignItems: "center" }]}>
          <Text style={[styles.labelSm, { alignSelf: "flex-start" }]}>SAFETY SCORE</Text>
          <View style={{ width: 88, height: 88, marginTop: 8, marginBottom: 4 }}>
            <Svg width="88" height="88">
              <Circle cx="44" cy="44" r="36" stroke="rgba(255,255,255,0.1)" strokeWidth="7" fill="none" />
              <Circle cx="44" cy="44" r="36" stroke={green} strokeWidth="7" fill="none" strokeDasharray={`${circumference}`} strokeDashoffset={circumference * (1 - safePct / 100)} strokeLinecap="round" rotation="-90" origin="44,44" />
            </Svg>
            <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 20, fontWeight: "800", color: white }}>{safePct}</Text>
              <Text style={{ fontSize: 9, color: muted }}>/100</Text>
            </View>
          </View>
        </View>
        <View style={[styles.card, { flex: 1 }]}>
          <Text style={[styles.labelSm, { marginBottom: 10 }]}>BEHAVIOR</Text>
          {[["Safe", safePct, green], ["Overspeed", overPct, red]].map(([l, v, c]: any) => (
            <View key={l} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                <Text style={{ fontSize: 11, color: white }}>{l}</Text>
                <Text style={{ fontSize: 11, color: c, fontWeight: "700" }}>{v}%</Text>
              </View>
              <View style={{ height: 4, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 2 }}>
                <View style={{ height: 4, width: `${v}%`, backgroundColor: c, borderRadius: 2 }} />
              </View>
            </View>
          ))}
        </View>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
        {[["TOTAL DISTANCE", `${totalDistance.toFixed(1)}`, "km"], ["TRAVEL TIME", fmtHM(totalTime), ""], ["TOTAL TRIPS", `${weekTrips.length}`, "trips"], ["MAX SPEED", `${maxSpeed}`, "km/h"]].map(([l, v, u]) => (
          <View key={l} style={[styles.card, { width: "47%" }]}>
            <Text style={styles.labelSm}>{l}</Text>
            <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 4 }}>
              <Text style={{ fontSize: 18, fontWeight: "800", color: white }}>{v}</Text>
              {!!u && <Text style={{ fontSize: 11, color: muted, marginLeft: 4 }}>{u}</Text>}
            </View>
          </View>
        ))}
      </View>

      <View style={[styles.card, { marginTop: 10 }]}>
        <Text style={{ color: white, fontWeight: "700", fontSize: 13 }}>Max Speed Overview</Text>
        <View style={{ flexDirection: "row", gap: 6, marginTop: 12 }}>
          {dayLabels.map((l, i) => <BarMini key={l} label={l} value={perDayMax[i]} />)}
        </View>
      </View>

      <View style={[styles.card, { marginTop: 10, marginBottom: 20 }]}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: white, fontWeight: "700", fontSize: 13 }}>Overspeed Events</Text>
          <Pill style={{ backgroundColor: "rgba(239,68,68,0.18)" }}><Text style={{ color: redBright, fontSize: 9, fontWeight: "700" }}>{overspeedEvents} THIS WEEK</Text></Pill>
        </View>
        <View style={{ flexDirection: "row", gap: 6, marginTop: 12 }}>
          {dayLabels.map((l, i) => (
            <View key={l} style={{ flex: 1, alignItems: "center" }}>
              <View style={{ height: 34, width: "100%", borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: perDayOverEvents[i] ? "rgba(239,68,68,0.22)" : "rgba(255,255,255,0.05)" }}>
                <Text style={{ color: perDayOverEvents[i] ? redBright : muted, fontWeight: "700", fontSize: 12 }}>{perDayOverEvents[i] || "-"}</Text>
              </View>
              <Text style={{ fontSize: 9, color: muted, marginTop: 4 }}>{l}</Text>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

// ---------- SHARE SCREEN (watch state lives in App so it survives tab switches) ----------
function ShareScreen({
  userId, shortId, userName, userRole, isTracking, latestLocation, speed, status,
  supabaseReady, pushToken, notificationsReady,
  watchCodeInput, setWatchCodeInput,
  watchedDriver, watchError, watchBusy,
  startWatching, stopWatching,
}: any) {
  const copyToClipboard = useCallback(async () => {
    if (shortId) {
      await Clipboard.setStringAsync(shortId);
      Alert.alert("Copied!", "Share code copied to clipboard.");
    }
  }, [shortId]);

  const loc = watchedDriver?.latest_location || null;
  const over = watchedDriver?.status === "OVERSPEED";
  const updatedAtMs = watchedDriver?.updated_at ? new Date(watchedDriver.updated_at).getTime() : 0;
  const stale = !loc || Date.now() - updatedAtMs > 25000;
  const pts: any[] = Array.isArray(watchedDriver?.route_points) ? watchedDriver.route_points : [];
  const isDriver = userRole === "driver";

  // ----- YOUR CODE CARD (what others use to watch you - drivers only) -----
  const myCodeCard = (
    <View style={[styles.card, { marginTop: 12, borderColor: isDriver ? green : border }]}>
      <Text style={{ color: white, fontWeight: "700", fontSize: 15 }}>
        {isDriver ? `🚗 ${userName || "My"}'s Driver Code` : "Your Code (guardians aren't tracked)"}
      </Text>
      {!notificationsReady && (
        <Text style={{ color: muted, fontSize: 10, marginTop: 4 }}>
          Notifications aren't enabled on this phone yet — allow them in your phone settings so overspeed alerts can reach you.
        </Text>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ color: muted, fontSize: 12 }}>{isDriver ? "Share Code:" : "Code:"}</Text>
          <Text style={{ color: isDriver ? green : muted, fontWeight: "bold", fontSize: 24, letterSpacing: 1 }}>{shortId || "Loading..."}</Text>
        </View>
        <Pressable onPress={copyToClipboard} style={[styles.pill, { backgroundColor: "rgba(34,197,94,0.18)", flexDirection: "row" }]}>
          <Feather name="copy" size={16} color={green} />
          <Text style={{ color: green, marginLeft: 4, fontWeight: "600" }}>Copy</Text>
        </Pressable>
      </View>
      {isDriver && (
        <>
          <Text style={{ color: muted, fontSize: 12, marginTop: 6 }}>
            Status: {isTracking ? (
              <Text style={{ color: green, fontWeight: "bold" }}>🔴 Sharing live</Text>
            ) : (
              <Text style={{ color: red, fontWeight: "bold" }}>⏸️ Not sharing (tap Start on Home)</Text>
            )}
          </Text>
          {isTracking && latestLocation && (
            <View style={{ marginTop: 8 }}>
              <Text style={{ color: white }}>📍 {latestLocation.lat.toFixed(5)}, {latestLocation.lng.toFixed(5)}</Text>
              <Text style={{ color: white }}>🏎️ Speed: {speed} km/h – {status}</Text>
            </View>
          )}
          <Text style={{ color: muted, fontSize: 11, marginTop: 8 }}>
            Give this code to a guardian — they'll see your live location and get overspeed alerts.
          </Text>
        </>
      )}
    </View>
  );

  // ----- WATCH A DRIVER CARD (guardian's main tool) -----
  const watchCard = (
    <View style={[styles.card, { marginTop: 12, borderColor: !isDriver ? green : border }]}>
      <Text style={{ color: white, fontWeight: "700", fontSize: 15 }}>👀 Watch a Driver</Text>
      <Text style={{ color: muted, fontSize: 12, marginBottom: 8 }}>
        Enter the DRIVER's Share Code to see their live location, speed and all activity:
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput
          style={{ flex: 1, backgroundColor: cardBg2, color: white, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: border }}
          placeholder="e.g. A3F9Z2"
          placeholderTextColor={muted}
          value={watchCodeInput}
          onChangeText={setWatchCodeInput}
          editable={!watchBusy}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <Pressable
          onPress={() => startWatching(watchCodeInput)}
          disabled={watchBusy}
          style={[styles.pill, { backgroundColor: watchBusy ? muted : green }]}
        >
          <Text style={{ color: "#05300f", fontWeight: "700" }}>{watchBusy ? "Finding…" : "Watch"}</Text>
        </Pressable>
      </View>
      {watchError ? <Text style={{ color: redBright, fontSize: 12, marginTop: 6 }}>{watchError}</Text> : null}

      {watchedDriver && (
        <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: border, paddingTop: 12, borderLeftWidth: 4, borderLeftColor: stale ? muted : over ? red : green, paddingLeft: 10 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: white, fontWeight: "700" }}>
              Watching: {watchedDriver.name || "Driver"} ({watchedDriver.short_id || ""})
            </Text>
            <Pressable onPress={stopWatching} style={[styles.pill, { backgroundColor: "rgba(239,68,68,0.18)" }]}>
              <Text style={{ color: redBright, fontWeight: "700" }}>Stop</Text>
            </Pressable>
          </View>
          <Text style={{ color: muted, fontSize: 10, marginTop: 2 }}>
            {pushToken
              ? "You'll get a push alert even when this app is closed if they overspeed."
              : notificationsReady
                ? "You'll get overspeed alerts while the app is open."
                : "Enable notifications to get overspeed alerts."}
          </Text>

          {loc ? (
            <>
              <View style={{ marginTop: 8 }}>
                <LiveMap lat={loc.lat} lng={loc.lng} points={pts} pins={[{ lat: loc.lat, lng: loc.lng, color: over ? red : green }]} height={200} />
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
                <Text style={{ color: white }}>Speed: {Math.round(watchedDriver.speed || 0)} km/h</Text>
                <Text style={{ color: stale ? muted : over ? redBright : greenBright, fontWeight: "700" }}>
                  {stale ? "OFFLINE" : over ? "OVERSPEED" : "SAFE"}
                </Text>
                <Text style={{ color: muted }}>
                  {updatedAtMs ? new Date(updatedAtMs).toLocaleTimeString() : ""}
                </Text>
              </View>
            </>
          ) : (
            <Text style={{ color: muted, marginTop: 8 }}>
              Connected — waiting for the driver to start sharing their live location.
            </Text>
          )}

          <View style={[styles.pill, { backgroundColor: "rgba(59,130,246,0.15)", marginTop: 10, alignSelf: "flex-start" }]}>
            <Text style={{ color: "#60a5fa", fontSize: 10, fontWeight: "700" }}>
              Open Home / Alerts / History / Report tabs to see ALL of this driver's activity
            </Text>
          </View>
        </View>
      )}
    </View>
  );

  return (
    <ScrollView style={{ paddingHorizontal: 16, flex: 1 }}>
      <Text style={{ color: white, fontWeight: "800", fontSize: 22 }}>Share Location</Text>

      {/* Identity header - shows WHO is sharing */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 }}>
        <View style={[styles.logoBox, { width: 38, height: 38, borderRadius: 19 }]}>
          <Text style={{ fontWeight: "900", color: "#05300f", fontSize: 14 }}>
            {(userName || "?").trim().slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: white, fontWeight: "800", fontSize: 16 }}>{userName || "Setting up…"}</Text>
          <Text style={{ color: muted, fontSize: 11, marginTop: 1 }}>
            {isDriver ? "Driver — share your code below" : "Guardian — enter a driver's code below"}
          </Text>
        </View>
        <View style={[styles.pill, { backgroundColor: isDriver ? "rgba(34,197,94,0.18)" : "rgba(59,130,246,0.18)", paddingVertical: 3, paddingHorizontal: 10 }]}>
          <Text style={{ color: isDriver ? green : "#60a5fa", fontSize: 10, fontWeight: "800" }}>{userRole.toUpperCase()}</Text>
        </View>
      </View>

      {!supabaseReady && (
        <View style={[styles.card, { backgroundColor: "rgba(239,68,68,0.15)", borderColor: red, marginTop: 12 }]}>
          <Text style={{ color: redBright, fontWeight: "700" }}>⚠️ Supabase not connected.</Text>
          <Text style={{ color: muted, fontSize: 12, marginTop: 4 }}>
            Check the Supabase URL/key and your internet connection.
          </Text>
        </View>
      )}

      {isDriver ? myCodeCard : watchCard}
      {isDriver ? watchCard : myCodeCard}
    </ScrollView>
  );
}

// ---------- SETUP SCREEN (no login, no password, no email) ----------
function SetupScreen({ onDone }: { onDone: (uid: string, name: string, role: "driver" | "guardian") => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<"driver" | "guardian">("driver");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleContinue = async () => {
    setError("");
    if (!name.trim()) return setError("Please enter your name.");
    setLoading(true);
    try {
      const uid = generateLocalId();
      let sid = Math.random().toString(36).substring(2, 8).toUpperCase();
      let collision = true;
      for (let i = 0; i < 5 && collision; i++) {
        const { data: same } = await supabase.from("users").select("id").eq("short_id", sid).maybeSingle();
        collision = !!same;
        if (collision) sid = Math.random().toString(36).substring(2, 8).toUpperCase();
      }
      const { error: upsertError } = await supabase.from("users").upsert({
        id: uid,
        name: name.trim(),
        role,
        short_id: sid,
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });
      if (upsertError) throw upsertError;

      await AsyncStorage.setItem("userId", uid);
      await AsyncStorage.setItem("shortId", sid);
      await AsyncStorage.setItem("userName", name.trim());
      await AsyncStorage.setItem("userRole", role);
      onDone(uid, name.trim(), role);
    } catch (err: any) {
      setError(err?.message || "Could not set up the app. Check your Supabase connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={["top", "bottom"]}>
        <StatusBar style="light" />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 22 }}>
          <View style={{ alignItems: "center", marginBottom: 28 }}>
            <View style={[styles.logoBox, { width: 58, height: 58, borderRadius: 16 }]}>
              <Text style={{ fontWeight: "900", color: "#05300f", fontSize: 22 }}>SR</Text>
            </View>
            <Text style={{ color: white, fontWeight: "900", fontSize: 28, marginTop: 12 }}>SafeRide</Text>
            <Text style={{ color: muted, fontSize: 13, marginTop: 4, textAlign: "center" }}>
              No login needed - just tell us who's using this phone
            </Text>
          </View>

          <View style={styles.authCard}>
            <Text style={styles.authLabel}>YOUR NAME</Text>
            <View style={styles.inputWrap}>
              <Feather name="user" size={17} color={muted} />
              <TextInput style={styles.authInput} placeholder="e.g. Dheeraj" placeholderTextColor={muted}
                value={name} onChangeText={setName} autoCapitalize="words" />
            </View>

            <View style={{ marginTop: 4 }}>
              <Text style={styles.authLabel}>THIS PHONE IS THE...</Text>
              <View style={{ flexDirection: "row", gap: 10 }}>
                {(["driver", "guardian"] as const).map((item) => (
                  <Pressable key={item} onPress={() => setRole(item)}
                    style={[styles.roleButton, role === item && { borderColor: green, backgroundColor: "rgba(34,197,94,0.12)" }]}>
                    <Feather name={item === "driver" ? "navigation" : "shield"} size={15} color={role === item ? green : muted} />
                    <Text style={{ color: role === item ? green : muted, fontWeight: "700", textTransform: "capitalize" }}>{item}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={{ color: muted, fontSize: 10, marginTop: 8 }}>
                {role === "driver"
                  ? "Driver = the phone that travels and gets tracked."
                  : "Guardian = the phone used to watch a driver via their Share Code."}
              </Text>
            </View>

            {error ? (
              <View style={styles.authError}>
                <Feather name="alert-circle" size={15} color={redBright} />
                <Text style={{ color: redBright, fontSize: 12, flex: 1 }}>{error}</Text>
              </View>
            ) : null}

            <Pressable onPress={handleContinue} disabled={loading} style={[styles.authButton, loading && { opacity: 0.6 }]}>
              <Text style={{ color: "#05300f", fontWeight: "900", fontSize: 14 }}>
                {loading ? "Setting up…" : "Continue"}
              </Text>
            </Pressable>

            <Text style={{ color: muted, fontSize: 10, lineHeight: 15, textAlign: "center", marginTop: 18 }}>
              This just creates a permanent id for this phone in your private Supabase project - no account, no password.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

// ---------- ROOT APP ----------
export default function App() {
  const [active, setActive] = useState("home");
  const [isTracking, setIsTracking] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [status, setStatus] = useState<"SAFE" | "OVERSPEED">("SAFE");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [route, setRoute] = useState<{ lat: number; lng: number }[]>([]);
  const [distanceKm, setDistanceKm] = useState(0);
  const [durationMin, setDurationMin] = useState(0);
  const [locationName, setLocationName] = useState("Locating…");
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [weeklyReports, setWeeklyReports] = useState<WeeklyReport[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [shortId, setShortId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("");
  const [userRole, setUserRole] = useState<"driver" | "guardian">("driver");
  const [supabaseReady, setSupabaseReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [notificationsReady, setNotificationsReady] = useState(false);
  const [pushToken, setPushToken] = useState<string | null>(null);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const lastCoordRef = useRef<{ lat: number; lng: number } | null>(null);
  const pointsRef = useRef<TripPoint[]>([]);
  const speedHistRef = useRef<number[]>([]);
  const statusRef = useRef<"SAFE" | "OVERSPEED">("SAFE");
  const startRef = useRef<number | null>(null);
  const timerRef = useRef<any>(null);
  const geocodeCache = useRef<Map<string, string>>(new Map());
  const supabasePushInterval = useRef<any>(null);
  const isExpoGo = Constants.appOwnership === 'expo';
  const NotificationsRef = useRef<any>(null);

  // ---------- REQUEST PERMISSIONS AFTER SETUP ----------
  useEffect(() => {
    if (!userId) return;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Location permission is required to track your ride.");
        setPermissionsGranted(false);
        return;
      }
      if (!isExpoGo) {
        try {
          const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
          if (bgStatus === "granted") {
            console.log("Background location permission granted");
          }
        } catch (e) {
          console.warn("Background permission failed:", e);
        }
      }
      setPermissionsGranted(true);

      // expo-notifications is fully removed from Expo Go on Android (SDK 53+)
      // - even importing it throws there. Skip it in that environment and
      // fall back to in-app Alert popups (see notifyLocal).
      const notificationsModuleAvailable = !isExpoGo || Platform.OS !== "android";
      if (notificationsModuleAvailable) {
        try {
          const Notifications = require("expo-notifications");
          if (Notifications && typeof Notifications.setNotificationHandler === "function") {
            NotificationsRef.current = Notifications;
            Notifications.setNotificationHandler({
              handleNotification: async () => ({
                shouldShowAlert: true,
                shouldPlaySound: true,
                shouldSetBadge: false,
              }),
            });
            const { status: notifStatus } = await Notifications.requestPermissionsAsync();
            setNotificationsReady(notifStatus === "granted");

            // Remote push token (so OTHER phones can alert this one while the app
            // is closed). Requires an EAS project id in app.json - run `eas init`.
            if (notifStatus === "granted" && !isExpoGo) {
              try {
                const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
                if (projectId) {
                  const tokenResult = await Notifications.getExpoPushTokenAsync({ projectId });
                  setPushToken(tokenResult.data);
                } else {
                  console.warn("No EAS projectId configured - skipping remote push token (run `eas init`).");
                }
              } catch (e) {
                console.warn("Push token registration failed:", e);
              }
            }
          }
        } catch (e) {
          console.warn("Local notifications unavailable - using in-app alert popups instead.");
        }
      }
    })();
  }, [userId]);

  // Save this device's push token onto its own users row once we have both.
  useEffect(() => {
    if (!userId || !supabaseReady || !pushToken) return;
    supabase.from("users").update({ push_token: pushToken }).eq("id", userId)
      .then(({ error }) => { if (error) console.warn("Saving push token failed:", error); });
  }, [userId, supabaseReady, pushToken]);

  // ---------- LOCAL (NO-AUTH) IDENTITY ----------
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [uid, sid, name, role] = await Promise.all([
          AsyncStorage.getItem("userId"),
          AsyncStorage.getItem("shortId"),
          AsyncStorage.getItem("userName"),
          AsyncStorage.getItem("userRole"),
        ]);
        if (!mounted) return;
        if (!uid) {
          setSupabaseReady(false);
          setAuthLoading(false);
          return;
        }

        setUserId(uid);
        setShortId(sid);
        setUserName(name || "");
        setUserRole((role as "driver" | "guardian") || "driver");

        // Make sure the row still exists / is up to date in Supabase.
        const { error } = await supabase.from("users").upsert({
          id: uid,
          name: name || "",
          role: role || "driver",
          short_id: sid,
          updated_at: new Date().toISOString(),
        }, { onConflict: "id" });
        if (error) throw error;
        setSupabaseReady(true);
      } catch (error) {
        console.warn("Supabase setup error:", error);
        setSupabaseReady(false);
        Alert.alert("Supabase setup error", "Could not sync your profile. Check your internet connection and that the SQL setup script has been run in Supabase.");
      } finally {
        if (mounted) setAuthLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // ---------- PUSH LIVE LOCATION TO SUPABASE ----------
  const pushLocationToSupabase = useCallback(async (lat: number, lng: number, spd: number, stat: string, points: any[]) => {
    if (!userId || !supabaseReady) return;
    try {
      const { error } = await supabase.from("users").update({
        latest_location: { lat, lng },
        speed: Math.round(spd),
        status: stat,
        route_points: points.slice(-100),
        updated_at: new Date().toISOString(),
      }).eq("id", userId);
      if (error) throw error;
    } catch (e) {
      console.warn("Supabase location update failed:", e);
    }
  }, [userId, supabaseReady]);

  // ---------- LOAD CLOUD DATA ----------
  useEffect(() => {
    if (!userId || !supabaseReady) return;

    let mounted = true;
    (async () => {
      try {
        const [tripRes, alertRes, reportRes] = await Promise.all([
          supabase.from("trips").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(500),
          supabase.from("alerts").select("*").eq("user_id", userId).order("timestamp", { ascending: false }).limit(500),
          supabase.from("weekly_reports").select("*").eq("user_id", userId).order("week_start", { ascending: false }).limit(20),
        ]);
        if (tripRes.error) throw tripRes.error;
        if (alertRes.error) throw alertRes.error;
        if (reportRes.error) throw reportRes.error;

        const cloudTrips: Trip[] = (tripRes.data || []).map((r: any) => ({
          id: r.id,
          date: r.date,
          points: r.points || [],
          distanceKm: Number(r.distance_km || 0),
          durationMin: Number(r.duration_min || 0),
          maxSpeed: Number(r.max_speed || 0),
        }));
        const cloudAlerts: AlertRecord[] = (alertRes.data || []).map((r: any) => ({
          id: r.id,
          type: r.type,
          speed: Number(r.speed || 0),
          location: r.location || "Unknown location",
          timestamp: new Date(r.timestamp).getTime(),
        }));
        const cloudReports: WeeklyReport[] = (reportRes.data || []).map((r: any) => ({
          weekStart: r.week_start,
          weekEnd: r.week_end,
          totalDistance: Number(r.total_distance || 0),
          totalTime: Number(r.total_time || 0),
          totalTrips: Number(r.total_trips || 0),
          maxSpeed: Number(r.max_speed || 0),
          safetyScore: Number(r.safety_score ?? 100),
          dailyMaxSpeeds: r.daily_max_speeds || [],
          dailyOverEvents: r.daily_over_events || [],
        }));

        if (mounted) {
          setTrips(cloudTrips);
          setAlerts(cloudAlerts);
          setWeeklyReports(cloudReports);
          await saveJSON("trips", cloudTrips);
          await saveJSON("alerts", cloudAlerts);
          await saveJSON("weeklyReports", cloudReports);
        }
      } catch (e) {
        console.warn("Cloud data load failed:", e);
        // Offline fallback
        if (mounted) {
          setAlerts(await loadJSON<AlertRecord[]>("alerts", []));
          setTrips(await loadJSON<Trip[]>("trips", []));
          setWeeklyReports(await loadJSON<WeeklyReport[]>("weeklyReports", []));
        }
      }
    })();

    return () => { mounted = false; };
  }, [userId, supabaseReady]);

  // ---------- GUARDIAN: WATCH A DRIVER (lives here so it survives tab switches) ----------
  const [watchCodeInput, setWatchCodeInput] = useState("");
  const [watchedDriver, setWatchedDriver] = useState<any | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState("");
  const [remoteAlerts, setRemoteAlerts] = useState<AlertRecord[]>([]);
  const [remoteTrips, setRemoteTrips] = useState<Trip[]>([]);
  const [remoteReports, setRemoteReports] = useState<WeeklyReport[]>([]);
  const watchChannelRef = useRef<any>(null);
  const watchPollRef = useRef<any>(null);
  const watchedIdRef = useRef<string | null>(null);
  const watchedStatusRef = useRef<"SAFE" | "OVERSPEED">("SAFE");

  // Local notification helper. If OS notifications are unavailable (Expo Go
  // on Android), show a visible in-app popup instead so alerts are never lost.
  const notifyLocal = useCallback(async (title: string, body: string) => {
    const Notifications = NotificationsRef.current;
    if (Notifications && notificationsReady) {
      try {
        await Notifications.scheduleNotificationAsync({
          content: { title, body, sound: "default" },
          trigger: null,
        });
        return;
      } catch (e) {
        console.warn("Local notification failed:", e);
      }
    }
    Alert.alert(title, body);
  }, [notificationsReady]);

  const applyDriverRow = useCallback((row: any) => {
    if (!row) return;
    setWatchedDriver((prev: any) => ({ ...(prev || {}), ...row }));
    const st: "SAFE" | "OVERSPEED" = row.status === "OVERSPEED" ? "OVERSPEED" : "SAFE";
    if (st !== watchedStatusRef.current) {
      const wentOver = st === "OVERSPEED";
      watchedStatusRef.current = st;
      notifyLocal(
        wentOver ? "⚠️ Overspeeding alert!" : "✅ Speed back to normal",
        `${row.name || "Driver"} is going ${Math.round(row.speed || 0)} km/h`
      );
    }
  }, [notifyLocal]);

  const loadDriverActivity = useCallback(async (driverId: string) => {
    try {
      const [t, a, r] = await Promise.all([
        supabase.from("trips").select("*").eq("user_id", driverId).order("created_at", { ascending: false }).limit(500),
        supabase.from("alerts").select("*").eq("user_id", driverId).order("timestamp", { ascending: false }).limit(500),
        supabase.from("weekly_reports").select("*").eq("user_id", driverId).order("week_start", { ascending: false }).limit(20),
      ]);
      if (t.error || a.error || r.error) throw t.error || a.error || r.error;
      setRemoteTrips((t.data || []).map((x: any) => ({
        id: x.id, date: x.date, points: x.points || [],
        distanceKm: Number(x.distance_km || 0), durationMin: Number(x.duration_min || 0), maxSpeed: Number(x.max_speed || 0),
      })));
      setRemoteAlerts((a.data || []).map((x: any) => ({
        id: x.id, type: x.type, speed: Number(x.speed || 0),
        location: x.location || "Unknown location", timestamp: new Date(x.timestamp).getTime(),
      })));
      setRemoteReports((r.data || []).map((x: any) => ({
        weekStart: x.week_start, weekEnd: x.week_end,
        totalDistance: Number(x.total_distance || 0), totalTime: Number(x.total_time || 0),
        totalTrips: Number(x.total_trips || 0), maxSpeed: Number(x.max_speed || 0),
        safetyScore: Number(x.safety_score ?? 100),
        dailyMaxSpeeds: x.daily_max_speeds || [], dailyOverEvents: x.daily_over_events || [],
      })));
    } catch (e) {
      console.warn("Loading driver activity failed:", e);
    }
  }, []);

  const teardownWatchConnection = useCallback(() => {
    if (watchChannelRef.current) {
      supabase.removeChannel(watchChannelRef.current);
      watchChannelRef.current = null;
    }
    if (watchPollRef.current) {
      clearInterval(watchPollRef.current);
      watchPollRef.current = null;
    }
  }, []);

  const subscribeDriver = useCallback((row: any) => {
    teardownWatchConnection();
    watchedIdRef.current = row.id;

    // Realtime channel for instant live updates of the driver's row + alerts.
    const channel = supabase
      .channel(`driver-live-${row.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "users", filter: `id=eq.${row.id}` },
        (payload: any) => {
          if (payload.eventType === "DELETE") {
            setWatchedDriver(null);
            setWatchError("This driver's profile was removed.");
          } else {
            applyDriverRow(payload.new);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "alerts", filter: `user_id=eq.${row.id}` },
        (payload: any) => {
          const r = payload.new;
          const rec: AlertRecord = {
            id: r.id,
            type: r.type,
            speed: Number(r.speed || 0),
            location: r.location || "Unknown location",
            timestamp: new Date(r.timestamp).getTime(),
          };
          setRemoteAlerts((prev) => [rec, ...prev.filter((x) => x.id !== rec.id)]);
          if (r.type === "alert") {
            notifyLocal("⚠️ Overspeed alert!", `${row.name || "Driver"} – ${rec.speed} km/h at ${rec.location}`);
          }
        }
      )
      .subscribe((state: string) => {
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          console.warn("Realtime channel problem - polling fallback stays active.");
        }
      });
    watchChannelRef.current = channel;

    // Polling fallback every 6s so the guardian ALWAYS sees fresh data even
    // if Realtime/websockets are blocked on their network.
    watchPollRef.current = setInterval(async () => {
      const id = watchedIdRef.current;
      if (!id) return;
      try {
        const { data, error } = await supabase.from("users").select("*").eq("id", id).maybeSingle();
        if (!error && data) applyDriverRow(data);
      } catch (e) { /* ignore transient network errors */ }
    }, 6000);
  }, [teardownWatchConnection, applyDriverRow, notifyLocal]);

  const startWatching = useCallback(async (rawCode: string, opts?: { silent?: boolean }) => {
    const code = (rawCode || "").trim().toUpperCase();
    const quiet = !!opts?.silent;
    if (!supabaseReady) { if (!quiet) setWatchError("Supabase is not connected."); return false; }
    if (!code) { if (!quiet) setWatchError("Please enter the driver's Share Code."); return false; }

    if (!quiet) setWatchBusy(true);
    try {
      const { data, error } = await supabase.from("users").select("*").eq("short_id", code).maybeSingle();
      if (error) throw error;
      if (!data) {
        if (!quiet) {
          setWatchError("No driver found with that Share Code. Ask the driver for their code from the Share tab.");
        } else {
          try { await AsyncStorage.removeItem("watchedCode"); } catch { }
        }
        return false;
      }
      if (userId && data.id === userId) {
        if (!quiet) setWatchError("That's your own Share Code.");
        return false;
      }
      // Only DRIVERS can be watched - a guardian's code is not shareable.
      if (data.role && data.role !== "driver") {
        if (!quiet) setWatchError("That code belongs to a GUARDIAN. Ask the driver for their Share Code instead.");
        return false;
      }

      setWatchError("");
      watchedStatusRef.current = data.status === "OVERSPEED" ? "OVERSPEED" : "SAFE";
      setWatchedDriver(data);
      setWatchCodeInput("");

      // Remember so watching resumes automatically next launch.
      await AsyncStorage.setItem("watchedCode", code);

      // Register this phone as a watcher so the DRIVER's app can send real
      // push notifications here when they overspeed (even app closed).
      if (userId) {
        try {
          await supabase.from("watchers").upsert({
            driver_id: data.id,
            guardian_id: userId,
            guardian_push_token: pushToken || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: "driver_id,guardian_id" });
        } catch (e) {
          console.warn("Watcher registration failed:", e);
        }
      }

      // If the driver is ALREADY overspeeding when we connect, alert immediately
      // (otherwise the guardian only hears about it on the next transition).
      if (data.status === "OVERSPEED") {
        notifyLocal(
          "⚠️ Overspeeding alert!",
          `${data.name || "Driver"} is going ${Math.round(data.speed || 0)} km/h right now`
        );
      }

      subscribeDriver(data);
      loadDriverActivity(data.id);
      return true;
    } catch (err: any) {
      if (!quiet) setWatchError(err?.message || "Could not find driver.");
      return false;
    } finally {
      if (!quiet) setWatchBusy(false);
    }
  }, [supabaseReady, userId, pushToken, subscribeDriver, loadDriverActivity, notifyLocal]);

  const stopWatching = useCallback(async () => {
    teardownWatchConnection();
    watchedIdRef.current = null;
    watchedStatusRef.current = "SAFE";
    setWatchedDriver(null);
    setWatchError("");
    setRemoteAlerts([]);
    setRemoteTrips([]);
    setRemoteReports([]);
    try { await AsyncStorage.removeItem("watchedCode"); } catch { }
  }, [teardownWatchConnection]);

  // Auto-resume watching the last driver code on launch.
  useEffect(() => {
    if (!userId || !supabaseReady) return;
    (async () => {
      const saved = await AsyncStorage.getItem("watchedCode");
      if (saved) startWatching(saved, { silent: true });
    })();
  }, [userId, supabaseReady, startWatching]);

  useEffect(() => {
    return () => {
      watchRef.current?.remove();
      if (timerRef.current) clearInterval(timerRef.current);
      if (supabasePushInterval.current) clearInterval(supabasePushInterval.current);
      teardownWatchConnection();
    };
  }, []);

  // ---------- WEEKLY REPORT ----------
  const generateWeeklyReport = useCallback((weekStart: Date, weekEnd: Date): WeeklyReport => {
    const startStr = weekStart.toISOString().slice(0, 10);
    const endStr = weekEnd.toISOString().slice(0, 10);
    const weekTrips = trips.filter(t => t.date >= startStr && t.date <= endStr);
    const weekAlerts = alerts.filter(a => {
      const d = new Date(a.timestamp);
      return d >= weekStart && d <= weekEnd;
    });
    const totalDistance = weekTrips.reduce((s, t) => s + t.distanceKm, 0);
    const totalTime = weekTrips.reduce((s, t) => s + t.durationMin, 0);
    const totalTrips = weekTrips.length;
    const maxSpeed = Math.max(0, ...weekTrips.map(t => t.maxSpeed));
    const allPoints = weekTrips.flatMap(t => t.points);
    const safePts = allPoints.filter(p => p.speed <= SPEED_LIMIT).length;
    const safetyScore = allPoints.length ? Math.round((safePts / allPoints.length) * 100) : 100;
    const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const dailyMaxSpeeds: number[] = [];
    const dailyOverEvents: number[] = [];
    dayLabels.forEach((_, i) => {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + i);
      const dayStr = day.toISOString().slice(0, 10);
      const dayTrips = weekTrips.filter(t => t.date === dayStr);
      const max = Math.max(0, ...dayTrips.map(t => t.maxSpeed));
      dailyMaxSpeeds.push(max);
      const overCount = weekAlerts.filter(a => a.type === "alert" && new Date(a.timestamp).toDateString() === day.toDateString()).length;
      dailyOverEvents.push(overCount);
    });
    return {
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      totalDistance,
      totalTime,
      totalTrips,
      maxSpeed,
      safetyScore,
      dailyMaxSpeeds,
      dailyOverEvents,
    };
  }, [trips, alerts]);

  const checkAndGenerateWeeklyReport = useCallback(async () => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    if (dayOfWeek === 1) {
      const lastMonday = new Date(today);
      lastMonday.setDate(today.getDate() - 7);
      const weekStart = mondayOf(lastMonday);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const savedReports = await loadJSON<WeeklyReport[]>("weeklyReports", []);
      const exists = savedReports.some(r => r.weekStart === weekStart.toISOString());
      if (!exists) {
        const report = generateWeeklyReport(weekStart, weekEnd);
        const updated = [...savedReports, report];
        await saveJSON("weeklyReports", updated);
        setWeeklyReports(updated);
        if (userId && supabaseReady) {
          try {
            await supabase.from("weekly_reports").upsert({
              user_id: userId,
              week_start: report.weekStart.slice(0, 10),
              week_end: report.weekEnd.slice(0, 10),
              total_distance: report.totalDistance,
              total_time: report.totalTime,
              total_trips: report.totalTrips,
              max_speed: report.maxSpeed,
              safety_score: report.safetyScore,
              daily_max_speeds: report.dailyMaxSpeeds,
              daily_over_events: report.dailyOverEvents,
            });
          } catch (e) {
            console.warn("Supabase weekly report save failed:", e);
          }
        }
      } else {
        setWeeklyReports(savedReports);
      }
    } else {
      const savedReports = await loadJSON<WeeklyReport[]>("weeklyReports", []);
      setWeeklyReports(savedReports);
    }
  }, [generateWeeklyReport, userId, supabaseReady]);

  useEffect(() => {
    if (trips.length > 0 || alerts.length > 0) {
      checkAndGenerateWeeklyReport();
    }
  }, [trips, alerts, checkAndGenerateWeeklyReport]);

  // ---------- GEOCODING ----------
  const reverseGeocode = useCallback(async (lat: number, lng: number) => {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (geocodeCache.current.has(key)) return geocodeCache.current.get(key)!;
    try {
      const [place] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      const name = place ? [place.street, place.district || place.city].filter(Boolean).join(", ") : "Unknown location";
      geocodeCache.current.set(key, name);
      return name;
    } catch {
      return "Unknown location";
    }
  }, []);

  // ---------- PUSH ALERT (with local notification) ----------
  const pushAlert = useCallback(async (type: "alert" | "normal", spd: number, lat: number, lng: number) => {
    const location = await reverseGeocode(lat, lng);
    const record: AlertRecord = { id: Date.now().toString(), type, speed: Math.round(spd), location, timestamp: Date.now() };
    setAlerts((prev) => {
      const next = [record, ...prev];
      saveJSON("alerts", next);
      return next;
    });
    if (userId && supabaseReady) {
      try {
        const { error } = await supabase.from("alerts").insert({
          user_id: userId,
          type,
          speed: Math.round(spd),
          location,
          timestamp: new Date().toISOString(),
        });
        if (error) throw error;
      } catch (e) {
        console.warn("Supabase alert insert failed:", e);
      }
    }

    // Notify on THIS phone (OS notification, or in-app popup in Expo Go Android)
    await notifyLocal(
      type === "alert" ? "⚠️ Speed Alert!" : "✅ Speed Normal",
      type === "alert"
        ? `Speed ${Math.round(spd)} km/h – Limit exceeded!`
        : `Speed back to normal (${Math.round(spd)} km/h)`
    );

    // Push a real notification to every guardian phone that is watching this
    // driver's Share Code - works even if her app is closed (needs dev build).
    if (type === "alert" && userId && supabaseReady) {
      try {
        const { data: watchers, error } = await supabase
          .from("watchers").select("guardian_push_token").eq("driver_id", userId);
        if (error) throw error;
        const tokens = (watchers || []).map((w: any) => w.guardian_push_token).filter(Boolean);
        if (tokens.length > 0) {
          await sendExpoPush(
            tokens,
            "⚠️ Overspeeding alert",
            `${userName || "Driver"} is going ${Math.round(spd)} km/h near ${location}`,
            { speed: spd, location }
          );
        }
      } catch (e) {
        console.warn("Guardian push notify failed:", e);
      }
    }
  }, [reverseGeocode, userId, supabaseReady, notifyLocal, userName]);

  // ---------- TRACKING LOGIC ----------
  const toggle = useCallback(async () => {
    if (isTracking) {
      watchRef.current?.remove();
      watchRef.current = null;
      if (timerRef.current) clearInterval(timerRef.current);
      if (supabasePushInterval.current) clearInterval(supabasePushInterval.current);
      if (pointsRef.current.length > 1 && startRef.current) {
        const maxSpeed = Math.max(...pointsRef.current.map((p) => p.speed));
        const trip: Trip = {
          id: Date.now().toString(),
          date: new Date(startRef.current).toISOString().slice(0, 10),
          points: pointsRef.current,
          distanceKm,
          durationMin: Math.round((Date.now() - startRef.current) / 60000),
          maxSpeed: Math.round(maxSpeed),
        };
        const next = [trip, ...trips];
        setTrips(next);
        saveJSON("trips", next);
        if (userId && supabaseReady) {
          try {
            const { data: inserted, error } = await supabase.from("trips").insert({
              user_id: userId,
              date: trip.date,
              points: trip.points,
              distance_km: trip.distanceKm,
              duration_min: trip.durationMin,
              max_speed: trip.maxSpeed,
            }).select("id").single();
            if (error) throw error;
            if (inserted?.id) {
              trip.id = inserted.id;
              const refreshed = [trip, ...trips];
              setTrips(refreshed);
              await saveJSON("trips", refreshed);
            }
          } catch (e) {
            console.warn("Supabase trip insert failed:", e);
          }
        }
      }
      setIsTracking(false);
      setSpeed(0);
      setRoute([]);
      setDistanceKm(0);
      setDurationMin(0);
      pointsRef.current = [];
      speedHistRef.current = [];
      lastCoordRef.current = null;
      startRef.current = null;
      if (userId && supabaseReady) {
        try {
          await supabase.from("users").update({
            latest_location: null,
            speed: 0,
            status: "SAFE",
            route_points: [],
            updated_at: new Date().toISOString(),
          }).eq("id", userId);
        } catch (e) { }
      }
      return;
    }

    if (!permissionsGranted) {
      Alert.alert("Permission Denied", "Location permission is required.");
      return;
    }

    setIsTracking(true);
    const now = Date.now();
    startRef.current = now;
    pointsRef.current = [];
    lastCoordRef.current = null;
    statusRef.current = "SAFE";
    setStatus("SAFE");
    setDistanceKm(0);
    setRoute([]);

    timerRef.current = setInterval(() => {
      if (startRef.current) setDurationMin(Math.round((Date.now() - startRef.current) / 60000));
    }, 15000);

    supabasePushInterval.current = setInterval(() => {
      const lastPt = pointsRef.current[pointsRef.current.length - 1];
      if (lastPt && userId && supabaseReady) {
        pushLocationToSupabase(
          lastPt.lat,
          lastPt.lng,
          lastPt.speed,
          statusRef.current,
          pointsRef.current.map(p => ({ lat: p.lat, lng: p.lng }))
        );
      }
    }, 5000);

    watchRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 8 },
      async (loc) => {
        const { latitude, longitude, speed: spd, accuracy } = loc.coords;

        // --- Reliable speed pipeline ---
        // 1. If the GPS fix itself is weak (>25m error), its speed reading is
        //    garbage - discard it.
        const acc = typeof accuracy === "number" ? accuracy : 999;
        let rawKmh = spd && spd > 0 ? spd * 3.6 : 0;
        if (acc > 25) rawKmh = 0;
        // 2. Median of the last 5 readings kills phantom spikes (e.g. showing
        //    11 km/h while sitting still from a single bad sample).
        speedHistRef.current.push(rawKmh);
        if (speedHistRef.current.length > 5) speedHistRef.current.shift();
        const sorted = [...speedHistRef.current].sort((a, b) => a - b);
        const medianKmh = sorted[Math.floor(sorted.length / 2)];
        // 3. Below walking pace counts as stationary (GPS drift floor).
        const speedKmh = medianKmh < MIN_MOVING_KMH ? 0 : Math.round(medianKmh);

        setCoords({ lat: latitude, lng: longitude });
        setSpeed(speedKmh);
        setRoute((prev) => [...prev, { lat: latitude, lng: longitude }]);
        const newPoint = { lat: latitude, lng: longitude, speed: speedKmh, timestamp: Date.now() };
        pointsRef.current.push(newPoint);

        if (lastCoordRef.current) {
          const d = haversineKm(lastCoordRef.current.lat, lastCoordRef.current.lng, latitude, longitude);
          // Only count distance on decent fixes while actually moving -
          // prevents GPS drift inflating the trip while parked/stationary.
          if (d > 0.01 && speedKmh > 0 && acc <= 50) setDistanceKm((prev) => prev + d);
        }
        lastCoordRef.current = { lat: latitude, lng: longitude };

        reverseGeocode(latitude, longitude).then(setLocationName);

        // Hysteresis: ALERT above 60 km/h; only return to SAFE below 55.
        // Stops rapid alert/safe flapping when GPS speed sits near the limit.
        const newStatus: "SAFE" | "OVERSPEED" =
          statusRef.current === "OVERSPEED"
            ? (speedKmh < SPEED_LIMIT - SAFE_BUFFER_KMH ? "SAFE" : "OVERSPEED")
            : (speedKmh > SPEED_LIMIT ? "OVERSPEED" : "SAFE");
        if (newStatus !== statusRef.current) {
          statusRef.current = newStatus;
          setStatus(newStatus);
          pushAlert(newStatus === "OVERSPEED" ? "alert" : "normal", speedKmh, latitude, longitude);
        }

        if (userId && supabaseReady) {
          pushLocationToSupabase(
            latitude,
            longitude,
            speedKmh,
            newStatus,
            pointsRef.current.map(p => ({ lat: p.lat, lng: p.lng }))
          );
        }
      }
    );
  }, [isTracking, distanceKm, trips, pushAlert, reverseGeocode, userId, supabaseReady, pushLocationToSupabase, permissionsGranted]);

  // ---------- RESET DEVICE (switch name / role on this phone) ----------
  const handleLogout = useCallback(async () => {
    try {
      if (isTracking) {
        watchRef.current?.remove();
        watchRef.current = null;
        if (timerRef.current) clearInterval(timerRef.current);
        if (supabasePushInterval.current) clearInterval(supabasePushInterval.current);
        setIsTracking(false);
      }
      await stopWatching();
      await AsyncStorage.multiRemove(["userId", "shortId", "userName", "userRole"]);
      setUserId(null);
      setShortId(null);
      setUserName("");
      setUserRole("driver");
      setSupabaseReady(false);
    } catch {
      Alert.alert("Reset failed", "Please try again.");
    }
  }, [isTracking, stopWatching]);

  // ---------- RENDER ----------
  if (authLoading) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
          <StatusBar style="light" />
          <View style={[styles.logoBox, { width: 52, height: 52, borderRadius: 14 }]}>
            <Text style={{ fontWeight: "900", color: "#05300f", fontSize: 20 }}>DR</Text>
          </View>
          <Text style={{ color: white, fontWeight: "800", fontSize: 18, marginTop: 12 }}>SafeRide</Text>
          <Text style={{ color: muted, fontSize: 12, marginTop: 4 }}>Checking your account…</Text>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!userId) {
    return <SetupScreen onDone={(uid, name, role) => {
      setUserId(uid);
      setUserName(name);
      setUserRole(role);
      setSupabaseReady(true);
      AsyncStorage.getItem("shortId").then(setShortId);
    }} />;
  }

  const watchingSomeone = !!watchedDriver;
  const watchedName: string | undefined = watchingSomeone ? (watchedDriver?.name || "Driver") : undefined;
  const displayAlerts = watchingSomeone ? remoteAlerts : alerts;
  const displayTrips = watchingSomeone ? remoteTrips : trips;
  const displayReports = watchingSomeone ? remoteReports : weeklyReports;

  const screens: any = {
    home: <HomeScreen tracking={{ isTracking, toggle, speed, status, coords, route, distanceKm, durationMin, locationName }} driverName={userName} watched={watchedDriver} />,
    alerts: <AlertsScreen alerts={displayAlerts} watchedName={watchedName} />,
    history: (
      <HistoryScreen
        trips={displayTrips}
        liveRoute={watchingSomeone ? (watchedDriver?.route_points || []) : route}
        isTracking={watchingSomeone ? !!watchedDriver?.latest_location : isTracking}
        watchedName={watchedName}
      />
    ),
    report: <ReportScreen trips={displayTrips} alerts={displayAlerts} weeklyReports={displayReports} watchedName={watchedName} />,
    share: (
      <ShareScreen
        userId={userId}
        shortId={shortId}
        userName={userName}
        userRole={userRole}
        isTracking={isTracking}
        latestLocation={coords}
        speed={speed}
        status={status}
        supabaseReady={supabaseReady}
        pushToken={pushToken}
        notificationsReady={notificationsReady}
        watchCodeInput={watchCodeInput}
        setWatchCodeInput={setWatchCodeInput}
        watchedDriver={watchedDriver}
        watchError={watchError}
        watchBusy={watchBusy}
        startWatching={startWatching}
        stopWatching={stopWatching}
      />
    ),
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={["top", "bottom"]}>
        <StatusBar style="light" />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 20, paddingBottom: 20 }}>
          {screens[active]}
        </ScrollView>
        <View style={{ paddingHorizontal: 16, paddingBottom: 4, alignItems: "flex-end" }}>
          <Pressable onPress={() => Alert.alert(
            "Reset this phone?",
            "This clears the name/role for this device. You'll set it up again next time.",
            [{ text: "Cancel", style: "cancel" }, { text: "Reset", style: "destructive", onPress: handleLogout }]
          )} style={{ paddingVertical: 4, paddingHorizontal: 8 }}>
            <Text style={{ color: muted, fontSize: 10, fontWeight: "700" }}>Reset device</Text>
          </Pressable>
        </View>
        <BottomNav active={active} setActive={setActive} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingBottom: 12 },
  logoBox: { width: 34, height: 34, borderRadius: 9, backgroundColor: green, alignItems: "center", justifyContent: "center" },
  card: { backgroundColor: cardBg, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: border },
  pill: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 10, color: muted, fontWeight: "700", letterSpacing: 0.5 },
  labelSm: { fontSize: 9, color: muted, fontWeight: "700", letterSpacing: 0.5 },
  bottomNav: { flexDirection: "row", borderTopWidth: 1, borderTopColor: border, paddingTop: 10, paddingBottom: 10, paddingHorizontal: 8 },
  navItem: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: "transparent" },

  // Authentication UI
  authCard: { backgroundColor: cardBg, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: border },
  authTabs: { flexDirection: "row", backgroundColor: cardBg2, borderRadius: 10, padding: 4, marginBottom: 16 },
  authTab: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 8 },
  authTabActive: { backgroundColor: "rgba(34,197,94,0.10)", borderWidth: 1, borderColor: "rgba(34,197,94,0.25)" },
  inputWrap: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: cardBg2, borderRadius: 10, borderWidth: 1, borderColor: border, paddingHorizontal: 12, marginBottom: 11 },
  authInput: { flex: 1, color: white, fontSize: 14, paddingVertical: 12 },
  authLabel: { color: muted, fontSize: 9, fontWeight: "800", letterSpacing: 0.7, marginBottom: 7 },
  roleButton: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingVertical: 11, borderRadius: 10, borderWidth: 1, borderColor: border },
  authError: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(239,68,68,0.10)", borderWidth: 1, borderColor: "rgba(239,68,68,0.25)", borderRadius: 10, padding: 10, marginTop: 12 },
  authButton: { backgroundColor: green, borderRadius: 11, alignItems: "center", justifyContent: "center", paddingVertical: 14, marginTop: 14 },
});
