import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, clearSession, getStoredUser, setSession } from "./api";
import Layout from "./components/Layout";
import { ToastProvider, useToast } from "./components/Toast";
import { ThemeProvider } from "./theme";
import type { User } from "./types";
import { isStaff } from "./types";
import Carrier from "./pages/Carrier";
import Dispatcher from "./pages/Dispatcher";
import Driver from "./pages/Driver";
import DriverHistory from "./pages/DriverHistory";
import DriverProfilePage from "./pages/DriverProfilePage";
import Landing from "./pages/Landing";
import Sender from "./pages/Sender";

function cabinetOf(role: User["role"]) {
  if (role === "sender") return "/sender";
  if (role === "carrier") return "/carrier";
  if (role === "driver") return "/driver";
  return "/dispatcher";
}

function AppInner() {
  const [user, setUser] = useState<User | null>(getStoredUser());
  const [loginOpen, setLoginOpen] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  async function login(email: string, password: string) {
    const data = await api<{ token: string; user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setSession(data.token, data.user);
    setUser(data.user);
    toast.ok(`Вы вошли как ${data.user.name}`);
    navigate(cabinetOf(data.user.role));
  }

  function logout() {
    clearSession();
    setUser(null);
    navigate("/");
  }

  useEffect(() => {
    const u = getStoredUser();
    if (u) setUser(u);
  }, []);

  return (
    <Layout
      user={user}
      onLogin={login}
      onLogout={logout}
      loginOpen={loginOpen}
      setLoginOpen={setLoginOpen}
      hideChrome={!user}
    >
      <Routes>
        <Route
          path="/"
          element={
            user ? <Navigate to={cabinetOf(user.role)} replace /> : <Landing onOpenLogin={() => setLoginOpen(true)} />
          }
        />
        <Route path="/sender" element={user?.role === "sender" ? <Sender /> : <Navigate to="/" />} />
        <Route
          path="/carrier"
          element={user?.role === "carrier" ? <Carrier user={user} /> : <Navigate to="/" />}
        />
        <Route
          path="/dispatcher"
          element={user && isStaff(user.role) ? <Dispatcher /> : <Navigate to="/" />}
        />
        <Route path="/driver" element={user?.role === "driver" ? <Driver user={user} /> : <Navigate to="/" />} />
        <Route
          path="/driver/history"
          element={user?.role === "driver" ? <DriverHistory /> : <Navigate to="/" />}
        />
        <Route
          path="/driver/profile"
          element={user?.role === "driver" ? <DriverProfilePage user={user} onUser={setUser} /> : <Navigate to="/" />}
        />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </ThemeProvider>
  );
}
