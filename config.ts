// Environment configuration for SafeRide
// In production, these should come from environment variables or a secure config.

export const CONFIG = {
  SUPABASE_URL: "https://utmgohephegziskyyfbl.supabase.co",
  SUPABASE_PUBLISHABLE_KEY:
    "sb_publishable_G28E7vZqCNanVPjOVBKqYw_FK8NNSje",

  // Speed limit in km/h
  SPEED_LIMIT: 60,

  // Buffer before overspeed status changes back to safe
  SAFE_BUFFER_KMH: 5,

  // Minimum speed to consider as moving (filters GPS noise)
  MIN_MOVING_KMH: 4,

  // Location update intervals
  FG_LOCATION_INTERVAL_MS: 5000,
  BG_LOCATION_INTERVAL_MS: 5000,
  BG_SYNC_INTERVAL_MS: 15000,

  // Supabase sync intervals
  TRIPS_POLL_INTERVAL_MS: 15000,
  ALERTS_POLL_INTERVAL_MS: 30000,
  WATCHED_DRIVER_POLL_INTERVAL_MS: 3000,
  FG_PUSH_INTERVAL_MS: 5000,

  // Trip auto-save interval (5 minutes)
  BG_TRIP_AUTOSAVE_MS: 300000,

  // Staleness threshold (ms) for watched driver location
  DRIVER_STALE_MS: 25000,

  // Max route points to store in Supabase
  MAX_ROUTE_POINTS_DB: 100,

  // Max points to store per trip
  MAX_TRIP_POINTS: 500,
} as const;
