import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = useCallback(async (userId) => {
    if (!userId) {
      setProfile(null);
      return;
    }
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();
    if (!error) setProfile(data);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      fetchProfile(data.session?.user?.id);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      fetchProfile(newSession?.user?.id);
    });

    return () => listener.subscription.unsubscribe();
  }, [fetchProfile]);

  const signUp = async ({ email, password, name }) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    return { data, error };
  };

  const signIn = async ({ email, password }) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    return { data, error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
  };

  const toggleRole = async (role) => {
    // role: "is_farmer" | "is_owner" — mutually exclusive: setting one turns the other off
    const other = role === "is_farmer" ? "is_owner" : "is_farmer";
    const patch = { [role]: true, [other]: false };

    if (!session?.user?.id) {
      return { data: null, error: { message: "You must be signed in to switch roles." } };
    }
    if (!profile) {
      // Defensive: profile row missing (e.g. handle_new_user trigger didn't fire).
      const { data: created, error: createErr } = await supabase
        .from("users")
        .upsert({ id: session.user.id, ...patch })
        .select()
        .single();
      if (createErr) return { data: null, error: createErr };
      setProfile(created);
      return { data: created, error: null };
    }
    const { data, error } = await supabase
      .from("users")
      .update(patch)
      .eq("id", session.user.id)
      .select()
      .single();
    if (!error) setProfile(data);
    return { data, error };
  };

  const updateProfile = async (fields) => {
    if (!session?.user?.id) return;
    const { data, error } = await supabase
      .from("users")
      .update(fields)
      .eq("id", session.user.id)
      .select()
      .single();
    if (!error) setProfile(data);
    return { data, error };
  };

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    loading,
    signUp,
    signIn,
    signOut,
    toggleRole,
    updateProfile,
    isAuthenticated: !!session,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
