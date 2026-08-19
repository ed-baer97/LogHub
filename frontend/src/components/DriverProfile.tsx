import { FormEvent, useState } from "react";
import { api, errText, getToken, setSession } from "../api";
import { useToast } from "./Toast";
import type { User } from "../types";

export default function DriverProfile({
  user,
  onUser,
}: {
  user: User;
  onUser: (user: User) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: user.name,
    email: user.email,
    phone: user.phone ?? "",
    current_password: "",
    password: "",
    password2: "",
  });
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (form.password && form.password !== form.password2) {
      toast.err("Новый пароль и подтверждение не совпадают");
      return;
    }
    const emailChanged = form.email.trim() !== user.email;
    const passwordChanged = Boolean(form.password);
    if ((emailChanged || passwordChanged) && !form.current_password) {
      toast.err("Для смены почты или пароля укажите текущий пароль");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, string | null> = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
      };
      if (emailChanged || passwordChanged) body.current_password = form.current_password;
      if (passwordChanged) body.password = form.password;
      const saved = await api<User>("/api/auth/me", { method: "PATCH", body: JSON.stringify(body) });
      const token = getToken();
      if (token) setSession(token, saved);
      onUser(saved);
      setForm((f) => ({ ...f, current_password: "", password: "", password2: "" }));
      toast.ok("Профиль сохранён");
    } catch (ex) {
      toast.err(errText(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="driver-profile">
      <p className="kicker">Профиль</p>
      <h2 className="display" style={{ fontSize: 32, marginBottom: 8 }}>
        Настройки
      </h2>
      <p className="lede">Имя, почта, телефон и пароль. Роль и борт здесь не меняются.</p>
      <form className="grid" onSubmit={save}>
        <label>
          Имя
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          Email
          <input
            required
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label>
          Телефон
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
        <label>
          Текущий пароль
          <input
            type="password"
            autoComplete="current-password"
            placeholder="нужен при смене почты или пароля"
            value={form.current_password}
            onChange={(e) => setForm({ ...form, current_password: e.target.value })}
          />
        </label>
        <label>
          Новый пароль
          <input
            type="password"
            autoComplete="new-password"
            placeholder="оставьте пустым, если не менять"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </label>
        <label>
          Повторите новый пароль
          <input
            type="password"
            autoComplete="new-password"
            value={form.password2}
            onChange={(e) => setForm({ ...form, password2: e.target.value })}
          />
        </label>
        <button className="btn driver-cta" type="submit" disabled={busy}>
          Сохранить
        </button>
      </form>
    </div>
  );
}
