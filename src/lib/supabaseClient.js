import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Fail loudly at startup rather than letting later Supabase calls fail
// with a confusing "invalid URL" error deep in some unrelated component.
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase env vars. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY " +
      "in .env.local (see .env.example)."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
