import { useState } from "react";
import { fetchMe, login } from "../api/client";
import { Banner } from "../components/Banner";
import { TextField } from "../components/TextField";

export function LoginPage({ onDone }: { onDone: (email: string) => void }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!email.trim() || !password) {
      setSubmitError("Podaj e-mail i hasło.");
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      await login({ email: email.trim(), password });
      const me = await fetchMe();
      onDone(me.email);
    } catch {
      // Celowo generyczny komunikat — szczegóły w logu serwera (security §7).
      setSubmitError("Nieprawidłowy e-mail lub hasło.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <main className="card auth-card" aria-labelledby="login-title">
        <h1 id="login-title" className="page-title">Logowanie</h1>
        <p className="age-text">Lokalny monitoring wind-up monitor — dane nie opuszczają Twojego serwera.</p>
        {submitError ? <Banner tone="error">{submitError}</Banner> : null}
        <form onSubmit={(event) => void handleSubmit(event)} noValidate>
          <TextField
            id="login-email"
            label="E-mail"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="username"
            required
          />
          <TextField
            id="login-password"
            label="Hasło"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            required
          />
          <button type="submit" className="btn btn--filled" disabled={busy}>
            {busy ? "Logowanie…" : "Zaloguj"}
          </button>
        </form>
      </main>
    </div>
  );
}
