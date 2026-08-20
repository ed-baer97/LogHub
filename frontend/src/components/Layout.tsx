import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { errText } from "../api";
import { useTheme } from "../theme";
import type { Role, User } from "../types";
import { useToast } from "./Toast";
import { HeaderHintProvider, useHeaderHintValue } from "./headerHint";
import Logo from "./Logo";

const CABINET: Record<Role, string> = {
  sender: "/sender",
  carrier: "/carrier",
  driver: "/driver",
  admin: "/dispatcher",
  superadmin: "/dispatcher",
  dispatcher: "/dispatcher",
};

const ROLE_RU: Record<Role, string> = {
  sender: "отправитель",
  carrier: "перевозчик",
  driver: "водитель",
  admin: "админ",
  superadmin: "супер-админ",
  dispatcher: "админ",
};

function LayoutInner({
  user,
  onLogin,
  onLogout,
  loginOpen,
  setLoginOpen,
  hideChrome,
  children,
}: {
  user: User | null;
  onLogin: (email: string, password: string) => Promise<void>;
  onLogout: () => void;
  loginOpen: boolean;
  setLoginOpen: (open: boolean) => void;
  hideChrome?: boolean;
  children: ReactNode;
}) {
  const cabinet = user ? CABINET[user.role] : null;
  const toast = useToast();
  const { theme, toggle } = useTheme();
  const headerHint = useHeaderHintValue();
  const open = loginOpen;
  const setOpen = setLoginOpen;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    emailRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onLogin(email.trim(), password);
      setOpen(false);
      setPassword("");
    } catch (ex) {
      toast.err(errText(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`app${hideChrome ? " land-app" : ""}`}>
      {!hideChrome && (
      <header className="topbar">
        <NavLink to={cabinet ?? "/"} className="brand">
          <Logo size={32} className="mark" />
          <h1>Caspian LogHub</h1>
          <span>Мангистау</span>
        </NavLink>
        <div className="userbox">
          <button
            className="btn secondary small theme-toggle"
            type="button"
            onClick={toggle}
            aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}
            title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          >
            {theme === "dark" ? "Светлая" : "Тёмная"}
          </button>
          {user ? (
            <>
              <span>
                <strong>{user.name}</strong>
                <br />
                {ROLE_RU[user.role]}
                {headerHint ? ` · ${headerHint}` : user.company ? ` · ${user.company}` : ""}
              </span>
              <button className="btn secondary small" onClick={onLogout}>
                Выйти
              </button>
            </>
          ) : (
            <button className="btn small" type="button" onClick={() => setOpen(true)}>
              Войти
            </button>
          )}
        </div>
      </header>
      )}
      {children}

      {open && !user && (
        <div className="modal-backdrop" onClick={() => setOpen(false)} role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-title"
            onClick={(e) => e.stopPropagation()}
          >
            <Logo size={44} className="modal-logo" alt="Caspian LogHub" />
            <p className="kicker">Авторизация</p>
            <h2 id="login-title" className="display" style={{ fontSize: 28 }}>
              Вход в кабинет
            </h2>
            <p className="lede">Email и пароль вашей роли.</p>
            <form className="grid" onSubmit={submit}>
              <label>
                Email
                <input
                  ref={emailRef}
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label>
                Пароль
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              <div className="row-actions">
                <button className="btn" type="submit" disabled={busy}>
                  Войти
                </button>
                <button className="btn secondary" type="button" onClick={() => setOpen(false)}>
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Layout(props: {
  user: User | null;
  onLogin: (email: string, password: string) => Promise<void>;
  onLogout: () => void;
  loginOpen: boolean;
  setLoginOpen: (open: boolean) => void;
  hideChrome?: boolean;
  children: ReactNode;
}) {
  return (
    <HeaderHintProvider>
      <LayoutInner {...props} />
    </HeaderHintProvider>
  );
}
