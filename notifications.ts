import { supabase } from "./supabase";
import { CONFIG } from "./config";

// ---------- SEND EXPO PUSH ----------
export async function sendExpoPush(
  tokens: string[],
  title: string,
  body: string,
  data?: any
): Promise<void> {
  const validTokens = tokens.filter(
    (t) => !!t && t.startsWith("ExponentPushToken")
  );
  if (validTokens.length === 0) return;
  try {
    // Expo batch limit is 100 messages per request
    const batches: string[][] = [];
    for (let i = 0; i < validTokens.length; i += 100) {
      batches.push(validTokens.slice(i, i + 100));
    }
    for (const batch of batches) {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          batch.map((to) => ({
            to,
            sound: "default",
            title,
            body,
            data,
            priority: "high",
          }))
        ),
      });
    }
  } catch (e) {
    console.warn("Expo push send failed:", e);
  }
}

// ---------- GET GUARDIAN TOKENS ----------
export async function getGuardianTokens(
  driverId: string
): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("watchers")
      .select("guardian_push_token")
      .eq("driver_id", driverId);
    if (error) throw error;
    return (data || [])
      .map((w: any) => w.guardian_push_token)
      .filter(Boolean);
  } catch (e) {
    console.warn("Failed to get guardian tokens:", e);
    return [];
  }
}

// ---------- NOTIFICATION: Tracking Started ----------
export async function notifyGuardiansTrackingStarted(
  driverId: string,
  driverName: string
): Promise<void> {
  const tokens = await getGuardianTokens(driverId);
  await sendExpoPush(
    tokens,
    "🟢 Location Sharing Started",
    `${driverName} has started sharing their live location with you.`,
    { type: "tracking_started", driverId }
  );
}

// ---------- NOTIFICATION: Tracking Stopped ----------
export async function notifyGuardiansTrackingStopped(
  driverId: string,
  driverName: string
): Promise<void> {
  const tokens = await getGuardianTokens(driverId);
  await sendExpoPush(
    tokens,
    "🔴 Location Sharing Stopped",
    `${driverName} has stopped sharing their live location.`,
    { type: "tracking_stopped", driverId }
  );
}

// ---------- NOTIFICATION: Speed Alert ----------
export async function notifyGuardiansSpeedAlert(
  driverId: string,
  driverName: string,
  speed: number
): Promise<void> {
  const tokens = await getGuardianTokens(driverId);
  await sendExpoPush(
    tokens,
    "⚠️ Speed Alert",
      `${driverName} is going ${speed} km/h — above the ${CONFIG.SPEED_LIMIT} km/h limit!`,
    { type: "speed_alert", driverId, speed }
  );
}

// ---------- NOTIFICATION: Speed Normal ----------
export async function notifyGuardiansSpeedNormal(
  driverId: string,
  driverName: string,
  speed: number
): Promise<void> {
  const tokens = await getGuardianTokens(driverId);
  await sendExpoPush(
    tokens,
    "✅ Speed Normal",
      `${driverName}'s speed is back below ${CONFIG.SPEED_LIMIT} km/h (${speed} km/h).`,
    { type: "speed_normal", driverId, speed }
  );
}
