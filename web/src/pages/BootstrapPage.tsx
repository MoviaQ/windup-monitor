import { useState } from "react";
import { bootstrap } from "../api/client";
import { Banner } from "../components/Banner";
import { TextField } from "../components/TextField";

const MIN_PASSWORD_LENGTH = 12;

export function BootstrapPage({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ token?: string; email?: string; password?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const next: typeof errors = {};
    if (!token.trim()) {
      next.token = "Wklej token bootstrap z pierwszego startu Core.";
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      next.email = "Podaj poprawny adres e-mail.";
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      next.password = `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.`;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      await bootstrap({ token: token.trim(), email: email.trim(), password });
      onDone();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Nie udało się utworzyć konta.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <main className="card auth-card" aria-labelledby="bootstrap-title">
        <h1 id="bootstrap-title" className="page-title">Pierwsza konfiguracja</h1>
        <p className="age-text">
          To pierwsze uruchomienie wind-up monitor. Ustaw hasło administratora — token bootstrap działa tylko raz.
        </p>
        {submitError ? <Banner tone="error">{submitError}</Banner> : null}
        <form onSubmit={(event) => void handleSubmit(event)} noValidate>
          <TextField
            id="bootstrap-token"
            label="Token bootstrap"
            value={token}
            onChange={setToken}
            error={errors.token}
            hint="Token wypisany raz na stdout pierwszego startu Core (lub w pliku 0600)."
            autoComplete="off"
            required
          />
          <TextField
            id="bootstrap-email"
            label="E-mail administratora"
            type="email"
            value={email}
            onChange={setEmail}
            error={errors.email}
            autoComplete="username"
            required
          />
          <TextField
            id="bootstrap-password"
            label="Hasło (min. 12 znaków)"
            type="password"
            value={password}
            onChange={setPassword}
            error={errors.password}
            autoComplete="new-password"
            required
          />
          <button type="submit" className="btn btn--filled" disabled={busy}>
            {busy ? "Tworzenie konta…" : "Utwórz konto"}
          </button>
        </form>
      </main>
    </div>
  );
}
