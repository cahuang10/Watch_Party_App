import { useEffect, useState } from "react";
import "./App.css";

function App() {
  // Confirms the Supabase client module loaded and initialized without
  // throwing (see src/lib/supabaseClient.js). This doesn't touch the
  // network yet — no tables exist until a later session — it's just
  // proof that VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are set correctly,
  // both locally and once deployed on Vercel.
  const [supabaseStatus, setSupabaseStatus] = useState("checking...");

  useEffect(() => {
    import("./lib/supabaseClient")
      .then(() => setSupabaseStatus("Supabase client initialized ✅"))
      .catch((err) => setSupabaseStatus(`Supabase client failed: ${err.message}`));
  }, []);

  return (
    <div className="app">
      <h1>Watch Party App</h1>
      <p>hello world</p>
      <p className="status">{supabaseStatus}</p>
    </div>
  );
}

export default App;
