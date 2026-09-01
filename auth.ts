import { supabase } from "./supabase";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "driver" | "guardian";
  shortId: string;
}

export interface SignUpResult {
  user: AuthUser | null;
  error: string | null;
  needsConfirmation?: boolean;
}

export interface SignInResult {
  user: AuthUser | null;
  error: string | null;
}

function generateShortId(name?: string): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  if (name && name.trim()) {
    let h = 0;
    const n = name.trim().toLowerCase();
    for (let i = 0; i < n.length; i++) {
      h = ((h << 5) - h + n.charCodeAt(i)) | 0;
    }
    let s = "";
    for (let i = 0; i < 6; i++) {
      h = Math.abs(h * 131 + i * 37);
      s += chars[h % chars.length];
    }
    return s;
  }
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

export async function signUp(
  email: string,
  password: string,
  name: string,
  role: "driver" | "guardian"
): Promise<SignUpResult> {
  try {
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();

    const { data, error } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
      options: {
        data: { name: trimmedName, role },
        emailRedirectTo: "safe-ride://",
      },
    });

    if (error) {
      return { user: null, error: error.message };
    }

    // If email confirmation is required, user will be null or session won't exist
    if (data.user && !data.session) {
      // Email confirmation required — save profile locally so we can use it later
      const userId = data.user.id;
      const shortId = generateShortId(trimmedName);

      await supabase.from("users").upsert({
        id: userId,
        email: trimmedEmail,
        name: trimmedName,
        role,
        short_id: shortId,
      }, { onConflict: "id" });

      return {
        user: { id: userId, email: trimmedEmail, name: trimmedName, role, shortId },
        error: null,
        needsConfirmation: true,
      };
    }

    if (!data.user) {
      return { user: null, error: "Sign up failed. Please try again." };
    }

    const userId = data.user.id;

    // Check if user profile already exists
    const { data: existing } = await supabase
      .from("users")
      .select("id, short_id, role")
      .eq("id", userId)
      .maybeSingle();

    const shortId = existing?.short_id || generateShortId(trimmedName);

    if (existing) {
      await supabase
        .from("users")
        .update({
          name: trimmedName,
          role,
          short_id: shortId,
          email: trimmedEmail,
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);
    } else {
      let finalShortId = shortId;
      const { data: conflict } = await supabase
        .from("users")
        .select("id")
        .eq("short_id", shortId)
        .maybeSingle();

      if (conflict) {
        finalShortId = generateShortId(trimmedName + Date.now().toString());
      }

      const { error: insertErr } = await supabase.from("users").insert({
        id: userId,
        email: trimmedEmail,
        name: trimmedName,
        role,
        short_id: finalShortId,
      });

      if (insertErr) {
        console.warn("[SafeRide] User profile insert error:", insertErr.message);
      }

      return {
        user: { id: userId, email: trimmedEmail, name: trimmedName, role, shortId: finalShortId },
        error: null,
      };
    }

    return {
      user: { id: userId, email: trimmedEmail, name: trimmedName, role, shortId: shortId },
      error: null,
    };
  } catch (e: any) {
    return { user: null, error: e?.message || "Sign up failed. Please try again." };
  }
}

export async function signIn(
  email: string,
  password: string
): Promise<SignInResult> {
  try {
    const trimmedEmail = email.trim().toLowerCase();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });

    if (error) {
      // Give a clearer message for unconfirmed emails
      if (error.message.includes("Email not confirmed") || error.message.includes("not confirmed")) {
        return { user: null, error: "Email not confirmed yet. Please check your inbox and confirm your email, then try again." };
      }
      return { user: null, error: error.message };
    }

    if (!data.user) {
      return { user: null, error: "Sign in failed. Please try again." };
    }

    const userId = data.user.id;

    // Fetch user profile from our users table
    const { data: profile } = await supabase
      .from("users")
      .select("name, role, short_id")
      .eq("id", userId)
      .maybeSingle();

    const name = profile?.name || data.user.user_metadata?.name || trimmedEmail.split("@")[0];
    const role = (profile?.role || data.user.user_metadata?.role || "driver") as "driver" | "guardian";
    const shortId = profile?.short_id || generateShortId(name);

    // Ensure profile exists and is up to date
    if (profile) {
      await supabase
        .from("users")
        .update({
          email: trimmedEmail,
          push_token: undefined,
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);
    } else {
      const { data: conflict } = await supabase
        .from("users")
        .select("id")
        .eq("short_id", shortId)
        .maybeSingle();

      const finalShortId = conflict ? generateShortId(name + Date.now().toString()) : shortId;

      await supabase.from("users").insert({
        id: userId,
        email: trimmedEmail,
        name,
        role,
        short_id: finalShortId,
      });
    }

    return {
      user: { id: userId, email: trimmedEmail, name, role, shortId },
      error: null,
    };
  } catch (e: any) {
    return { user: null, error: e?.message || "Sign in failed. Please try again." };
  }
}

export async function signOut(): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      return { error: error.message };
    }
    return { error: null };
  } catch (e: any) {
    return { error: e?.message || "Sign out failed." };
  }
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      return null;
    }

    const userId = session.user.id;
    const email = session.user.email || "";

    // Fetch profile from users table
    const { data: profile } = await supabase
      .from("users")
      .select("name, role, short_id")
      .eq("id", userId)
      .maybeSingle();

    if (!profile) {
      return {
        id: userId,
        email,
        name: session.user.user_metadata?.name || email.split("@")[0],
        role: (session.user.user_metadata?.role || "driver") as "driver" | "guardian",
        shortId: "",
      };
    }

    return {
      id: userId,
      email,
      name: profile.name,
      role: profile.role as "driver" | "guardian",
      shortId: profile.short_id || "",
    };
  } catch {
    return null;
  }
}

export async function resetPassword(
  email: string
): Promise<{ error: string | null }> {
  try {
    const trimmedEmail = email.trim().toLowerCase();
    const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
      redirectTo: "safe-ride://reset-password",
    });
    if (error) {
      return { error: error.message };
    }
    return { error: null };
  } catch (e: any) {
    return { error: e?.message || "Password reset failed." };
  }
}

export async function updatePushToken(
  token: string | null
): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return;
    await supabase
      .from("users")
      .update({ push_token: token, updated_at: new Date().toISOString() })
      .eq("id", session.user.id);
  } catch {}
}
