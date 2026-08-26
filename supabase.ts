import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

// IMPORTANT: Supabase publishable keys do not contain your project URL.
// Replace YOUR_PROJECT_REF with the project reference shown in:
// Supabase Dashboard -> Project Settings -> General.
const SUPABASE_URL = "https://utmgohephegziskyyfbl.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_G28E7vZqCNanVPjOVBKqYw_FK8NNSje";

export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  }
);
