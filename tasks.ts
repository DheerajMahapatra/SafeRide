import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

// ---------- REVERSE GEOCODE HELPER ----------
async function reverseGeocodeName(lat: number, lng: number): Promise<string> {
  try {
    const results = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    if (results && results.length > 0) {
      const r = results[0];
      return [r.street, r.district || r.city].filter(Boolean).join(", ") || "Unknown location";
    }
  } catch (_e) {}
  return "Unknown location";
}

// ---------- CONSTANTS ----------
export const BACKGROUND_LOCATION_TASK = "saferide-background-location";
export const BACKGROUND_SYNC_TASK = "saferide-background-sync";

const SPEED_LIMIT = 60;
const SAFE_BUFFER_KMH = 5;
const MIN_MOVING_KMH = 4;

const SUPABASE_URL = "https://utmgohephegziskyyfbl.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_G28E7vZqCNanVPjOVBKqYw_FK8NNSje";

function getSupabaseClient() {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- BACKGROUND LOCATION TASK ----------
// This task runs even when the app is killed on Android (via foreground service).
// It receives GPS updates and stores them in AsyncStorage for the foreground app
// to pick up, and also pushes to Supabase directly.
try {
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn("[SafeRide BG] Location task error:", error.message);
    return;
  }

  const location = (data as any)?.locations?.[0];
  if (!location) return;

  try {
    const trackingActive = await AsyncStorage.getItem("trackingActive");
    if (trackingActive !== "true") return;

    const { latitude, longitude, speed: spd, accuracy } = location.coords;

    // Read accumulated state from AsyncStorage
    const [pointsRaw, lastLatRaw, lastLngRaw, distRaw, histRaw, statusRaw, startRaw, bgFirstPushRaw] =
      await Promise.all([
        AsyncStorage.getItem("bg_points"),
        AsyncStorage.getItem("bg_lastLat"),
        AsyncStorage.getItem("bg_lastLng"),
        AsyncStorage.getItem("bg_distance"),
        AsyncStorage.getItem("bg_speedHist"),
        AsyncStorage.getItem("bg_status"),
        AsyncStorage.getItem("bg_startTime"),
        AsyncStorage.getItem("bg_firstPushDone"),
      ]);

    let points: { lat: number; lng: number; speed: number; timestamp: number }[] =
      pointsRaw ? JSON.parse(pointsRaw) : [];
    let lastLat = lastLatRaw ? parseFloat(lastLatRaw) : null;
    let lastLng = lastLngRaw ? parseFloat(lastLngRaw) : null;
    let distance = distRaw ? parseFloat(distRaw) : 0;
    let speedHist: number[] = histRaw ? JSON.parse(histRaw) : [];
    let currentStatus: "SAFE" | "OVERSPEED" = statusRaw === "OVERSPEED" ? "OVERSPEED" : "SAFE";
    const startTime = startRaw ? parseInt(startRaw, 10) : Date.now();

    // Speed pipeline (same as foreground)
    const acc = typeof accuracy === "number" ? accuracy : 999;
    let rawKmh = spd && spd > 0 ? spd * 3.6 : 0;
    if (acc > 25) rawKmh = 0;

    speedHist.push(rawKmh);
    if (speedHist.length > 5) speedHist.shift();
    const sorted = [...speedHist].sort((a, b) => a - b);
    const medianKmh = sorted[Math.floor(sorted.length / 2)];
    const speedKmh = medianKmh < MIN_MOVING_KMH ? 0 : Math.round(medianKmh);

    const newPoint = {
      lat: latitude,
      lng: longitude,
      speed: speedKmh,
      timestamp: Date.now(),
    };
    points.push(newPoint);

    // Distance
    if (lastLat !== null && lastLng !== null) {
      const d = haversineKm(lastLat, lastLng, latitude, longitude);
      if (d > 0.01 && speedKmh > 0 && acc <= 50) distance += d;
    }

    // Status hysteresis
    const hasEnoughSamples = speedHist.length >= 3;
    const newStatus: "SAFE" | "OVERSPEED" = !hasEnoughSamples ? "SAFE" :
      currentStatus === "OVERSPEED"
        ? speedKmh < SPEED_LIMIT - SAFE_BUFFER_KMH
          ? "SAFE"
          : "OVERSPEED"
        : speedKmh > SPEED_LIMIT
          ? "OVERSPEED"
          : "SAFE";

    const statusChanged = newStatus !== currentStatus;

    // Save accumulated state back
    await Promise.all([
      AsyncStorage.setItem("bg_points", JSON.stringify(points.slice(-500))),
      AsyncStorage.setItem("bg_lastLat", latitude.toString()),
      AsyncStorage.setItem("bg_lastLng", longitude.toString()),
      AsyncStorage.setItem("bg_distance", distance.toString()),
      AsyncStorage.setItem("bg_speedHist", JSON.stringify(speedHist)),
      AsyncStorage.setItem("bg_status", newStatus),
      AsyncStorage.setItem("bg_lastUpdate", Date.now().toString()),
    ]);

    // Push to Supabase
    const userId = await AsyncStorage.getItem("userId");
    const userName = (await AsyncStorage.getItem("userName")) || "Driver";
    if (userId) {
      try {
        const supabase = getSupabaseClient();
        const routePoints = points.slice(-100).map((p) => ({
          lat: p.lat,
          lng: p.lng,
        }));

        const updatePayload: any = {
          latest_location: { lat: latitude, lng: longitude, distance: distance },
          speed: speedKmh,
          status: newStatus,
          route_points: routePoints,
          updated_at: new Date().toISOString(),
        };

        // First push after background task starts: mark tracking_active + notify guardians
        if (!bgFirstPushRaw) {
          updatePayload.tracking_active = true;
          await AsyncStorage.setItem("bg_firstPushDone", "true");
          // Notify guardians tracking started from background
          try {
            const { data: watchers } = await supabase
              .from("watchers").select("guardian_push_token").eq("driver_id", userId);
            const tokens = (watchers || []).map((w: any) => w.guardian_push_token)
              .filter((t: string) => !!t && t.startsWith("ExponentPushToken"));
            if (tokens.length > 0) {
              await fetch("https://exp.host/--/api/v2/push/send", {
                method: "POST",
                headers: { Accept: "application/json", "Content-Type": "application/json" },
                body: JSON.stringify(tokens.map((to: string) => ({
                  to, sound: "default",
                  title: "🟢 Location Sharing Started",
                  body: `${userName} has started sharing their live location with you.`,
                  data: { type: "tracking_started", driverId: userId },
                  priority: "high",
                }))),
              });
            }
          } catch (_e) {}
        }

        await supabase.from("users").update(updatePayload).eq("id", userId);

        // If status changed, create alert and notify guardians
        if (statusChanged) {
          currentStatus = newStatus;
          await AsyncStorage.setItem("bg_status", newStatus);

          const alertLocation = await reverseGeocodeName(latitude, longitude);
          await supabase.from("alerts").insert({
            user_id: userId,
            type: newStatus === "OVERSPEED" ? "alert" : "normal",
            speed: speedKmh,
            location: alertLocation,
            timestamp: new Date().toISOString(),
          });

          if (newStatus === "OVERSPEED") {
            const { data: watchers } = await supabase
              .from("watchers").select("guardian_push_token").eq("driver_id", userId);
            const tokens = (watchers || []).map((w: any) => w.guardian_push_token)
              .filter((t: string) => !!t && t.startsWith("ExponentPushToken"));
            if (tokens.length > 0) {
              const pushLocation = await reverseGeocodeName(latitude, longitude);
              await fetch("https://exp.host/--/api/v2/push/send", {
                method: "POST",
                headers: { Accept: "application/json", "Content-Type": "application/json" },
                body: JSON.stringify(tokens.map((to: string) => ({
                  to, sound: "default",
                  title: "⚠️ Speed Alert",
                  body: `${userName} is going ${speedKmh} km/h near ${pushLocation}`,
                  data: { speed: speedKmh },
                  priority: "high",
                }))),
              });
            }
          }
        }

        // Periodic trip auto-save: every 5 minutes, save a snapshot to prevent data loss on app kill
        const lastAutoSave = await AsyncStorage.getItem("bg_lastAutoSave");
        const now = Date.now();
        if (!lastAutoSave || now - parseInt(lastAutoSave, 10) > 300000) {
          await AsyncStorage.setItem("bg_lastAutoSave", now.toString());
          const durationSec = Math.round((now - startTime) / 1000);
          if (points.length > 2 && durationSec > 60) {
            try {
              const startLoc = points.length > 0 ? await reverseGeocodeName(points[0].lat, points[0].lng) : "Unknown";
              const endLoc = await reverseGeocodeName(latitude, longitude);
              const alertCount = (await supabase.from("alerts").select("id", { count: "exact", head: true })
                .eq("user_id", userId).gte("timestamp", new Date(startTime).toISOString())).count || 0;
              await supabase.from("trips").insert({
                user_id: userId,
                date: new Date().toISOString().slice(0, 10),
                points: points.slice(-500),
                distance_km: distance,
                duration_sec: durationSec,
                max_speed: Math.max(0, ...points.map(p => p.speed)),
                avg_speed: points.length > 1 ? Math.round(points.reduce((s, p) => s + p.speed, 0) / points.length) : 0,
                alerts_count: alertCount,
                started_at: new Date(startTime).toISOString(),
                ended_at: new Date().toISOString(),
                tracking_status: "active",
                start_location: startLoc,
                end_location: endLoc,
                guardian_notified: false,
              });
              console.log("[SafeRide BG] Auto-saved trip:", points.length, "points,", durationSec, "sec");
            } catch (e) {
              console.warn("[SafeRide BG] Auto-save trip failed:", e);
            }
          }
        }
      } catch (e) {
        console.warn("[SafeRide BG] Supabase push failed:", e);
      }
    }
  } catch (e) {
    console.warn("[SafeRide BG] Task processing error:", e);
  }
});
} catch(e) { console.warn("[SafeRide BG] defineTask not available (Expo Go):", (e as Error).message); }

// ---------- BACKGROUND SYNC TASK ----------
// Periodic task that ensures the latest location is pushed to Supabase
// even if the location task hasn't fired recently.
try {
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const trackingActive = await AsyncStorage.getItem("trackingActive");
    if (trackingActive !== "true") return;

    const userId = await AsyncStorage.getItem("userId");
    const lastUpdate = await AsyncStorage.getItem("bg_lastUpdate");
    if (!userId || !lastUpdate) return;

    // Only sync if last update was more than 15 seconds ago
    if (Date.now() - parseInt(lastUpdate, 10) < 15000) return;

    const lastLat = await AsyncStorage.getItem("bg_lastLat");
    const lastLng = await AsyncStorage.getItem("bg_lastLng");
    const speed = await AsyncStorage.getItem("bg_speedHist");
    const status = await AsyncStorage.getItem("bg_status");
    const pointsRaw = await AsyncStorage.getItem("bg_points");

    if (!lastLat || !lastLng) return;

    const speedHist = speed ? JSON.parse(speed) : [0];
    const sorted = [...speedHist].sort((a: number, b: number) => a - b);
    const currentSpeed = sorted[Math.floor(sorted.length / 2)] || 0;
    const points = pointsRaw ? JSON.parse(pointsRaw) : [];

    const supabase = getSupabaseClient();
    const distRaw2 = await AsyncStorage.getItem("bg_distance");
    const bgDistance = distRaw2 ? parseFloat(distRaw2) : 0;
    await supabase
      .from("users")
      .update({
        latest_location: { lat: parseFloat(lastLat), lng: parseFloat(lastLng), distance: bgDistance },
        speed: Math.round(currentSpeed),
        status: status || "SAFE",
        route_points: points.slice(-100).map((p: any) => ({
          lat: p.lat,
          lng: p.lng,
        })),
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);
  } catch (e) {
    console.warn("[SafeRide BG] Sync task error:", e);
  }
});
} catch(e) { console.warn("[SafeRide BG] sync defineTask not available (Expo Go):", (e as Error).message); }

// ---------- HELPER: Start Background Location ----------
export async function startBackgroundLocation(): Promise<boolean> {
  // Initialize state so foreground tracking always works
  await Promise.all([
    AsyncStorage.setItem("trackingActive", "true"),
    AsyncStorage.setItem("bg_points", "[]"),
    AsyncStorage.setItem("bg_distance", "0"),
    AsyncStorage.setItem("bg_speedHist", "[]"),
    AsyncStorage.setItem("bg_status", "SAFE"),
    AsyncStorage.setItem("bg_startTime", Date.now().toString()),
    AsyncStorage.setItem("bg_firstPushDone", ""),
    AsyncStorage.setItem("bg_lastAutoSave", ""),
  ]);

  // Check if background APIs are available (not in Expo Go)
  const hasTaskManager = typeof TaskManager.isTaskRegisteredAsync === "function";
  const hasBgLocation = typeof (Location as any).startLocationUpdatesAsync === "function";
  if (!hasTaskManager || !hasBgLocation) {
    return false;
  }

  // Skip background location in Expo Go — it doesn't work there and logs a warning
  try {
    const Constants = require("expo-constants");
    const ownership = Constants?.default?.appOwnership ?? Constants?.appOwnership;
    if (ownership === "expo") {
      console.log("[SafeRide BG] Skipping background location in Expo Go (use dev build for background tracking)");
      return false;
    }
  } catch (_e) {}

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(
      BACKGROUND_LOCATION_TASK
    );
    if (isRegistered) {
      await (Location as any).stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }

    await (Location as any).startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: 5000,
      distanceInterval: 10,
      deferredUpdatesInterval: 5000,
      foregroundService: {
        notificationTitle: "SafeRide",
        notificationBody: "Location sharing is active",
        notificationColor: "#22c55e",
        notificationAndroidChannelId: "saferide-tracking",
      },
      showsBackgroundLocationIndicator: true,
    });

    // Background fetch sync task registration (requires expo-background-fetch)
    // If not available, the background location task alone handles syncing.
    try {
      const BackgroundFetch = require("expo-background-fetch");
      if (BackgroundFetch && typeof BackgroundFetch.registerTaskAsync === "function") {
        const syncRegistered = await TaskManager.isTaskRegisteredAsync(
          BACKGROUND_SYNC_TASK
        );
        if (!syncRegistered) {
          await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
            minimumInterval: 15,
            stopOnTerminate: false,
            startOnBoot: true,
          });
        }
      }
    } catch (_e) {
      // expo-background-fetch not available - background location task handles syncing
    }

    console.log("[SafeRide BG] Background location started successfully");
    return true;
  } catch (e: any) {
    console.warn("[SafeRide BG] Background location not available:", e.message || e);
    return false;
  }
}

// ---------- HELPER: Stop Background Location ----------
export async function stopBackgroundLocation(): Promise<void> {
  try {
    // Read final state before clearing
    const userId = await AsyncStorage.getItem("userId");
    const userName = (await AsyncStorage.getItem("userName")) || "Driver";
    const trackingActive = await AsyncStorage.getItem("trackingActive");
    const pointsRaw = await AsyncStorage.getItem("bg_points");
    const distRaw = await AsyncStorage.getItem("bg_distance");
    const startRaw = await AsyncStorage.getItem("bg_startTime");

    // Save final trip if there's data
    if (trackingActive === "true" && userId && pointsRaw) {
      const points = JSON.parse(pointsRaw);
      const distance = distRaw ? parseFloat(distRaw) : 0;
      const startTime = startRaw ? parseInt(startRaw, 10) : Date.now();
      const durationSec = Math.round((Date.now() - startTime) / 1000);

      if (points.length > 1 && durationSec > 10) {
        try {
          const supabase = getSupabaseClient();
          const startLoc = await reverseGeocodeName(points[0].lat, points[0].lng);
          const endLoc = await reverseGeocodeName(points[points.length - 1].lat, points[points.length - 1].lng);
          await supabase.from("trips").insert({
            user_id: userId,
            date: new Date().toISOString().slice(0, 10),
            points: points.slice(-500),
            distance_km: distance,
            duration_sec: durationSec,
            max_speed: Math.max(0, ...points.map((p: any) => p.speed)),
            avg_speed: points.length > 1 ? Math.round(points.reduce((s: number, p: any) => s + p.speed, 0) / points.length) : 0,
            alerts_count: 0,
            started_at: new Date(startTime).toISOString(),
            ended_at: new Date().toISOString(),
            tracking_status: "completed",
            start_location: startLoc,
            end_location: endLoc,
            guardian_notified: false,
          });
          console.log("[SafeRide BG] Final trip saved:", points.length, "points");
        } catch (e) {
          console.warn("[SafeRide BG] Final trip save failed:", e);
        }
      }

      // Mark tracking inactive in Supabase
      try {
        const supabase = getSupabaseClient();
        await supabase.from("users").update({ tracking_active: false, updated_at: new Date().toISOString() }).eq("id", userId);
      } catch (_e) {}

      // Notify guardians tracking stopped
      try {
        const supabase = getSupabaseClient();
        const { data: watchers } = await supabase.from("watchers").select("guardian_push_token").eq("driver_id", userId);
        const tokens = (watchers || []).map((w: any) => w.guardian_push_token).filter((t: string) => !!t && t.startsWith("ExponentPushToken"));
        if (tokens.length > 0) {
          await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(tokens.map((to: string) => ({
              to, sound: "default",
              title: "🔴 Location Sharing Stopped",
              body: `${userName} has stopped sharing their live location.`,
              data: { type: "tracking_stopped", driverId: userId },
              priority: "high",
            }))),
          });
        }
      } catch (_e) {}
    }

    await AsyncStorage.setItem("trackingActive", "false");
    await AsyncStorage.setItem("bg_firstPushDone", "");
    await AsyncStorage.setItem("bg_lastAutoSave", "");

    if (typeof TaskManager.isTaskRegisteredAsync === "function") {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(
        BACKGROUND_LOCATION_TASK
      );
      if (isRegistered) {
        await (Location as any).stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      }
    }
  } catch (e) {
    console.warn("[SafeRide BG] Failed to stop background location:", e);
  }
}

// ---------- HELPER: Read accumulated background data ----------
export async function readBackgroundData(): Promise<{
  points: { lat: number; lng: number; speed: number; timestamp: number }[];
  distance: number;
  status: "SAFE" | "OVERSPEED";
  startTime: number;
} | null> {
  try {
    const active = await AsyncStorage.getItem("trackingActive");
    if (active !== "true") return null;

    const [pointsRaw, distRaw, statusRaw, startRaw] = await Promise.all([
      AsyncStorage.getItem("bg_points"),
      AsyncStorage.getItem("bg_distance"),
      AsyncStorage.getItem("bg_status"),
      AsyncStorage.getItem("bg_startTime"),
    ]);

    return {
      points: pointsRaw ? JSON.parse(pointsRaw) : [],
      distance: distRaw ? parseFloat(distRaw) : 0,
      status: statusRaw === "OVERSPEED" ? "OVERSPEED" : "SAFE",
      startTime: startRaw ? parseInt(startRaw, 10) : Date.now(),
    };
  } catch {
    return null;
  }
}
