import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";

export default function DriverShell({ children }: { children: ReactNode }) {
  return (
    <div className="driver-page">
      <nav className="driver-nav">
        <NavLink to="/driver" end className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
          Рейс
        </NavLink>
        <NavLink to="/driver/history" className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
          История
        </NavLink>
        <NavLink to="/driver/profile" className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
          Профиль
        </NavLink>
      </nav>
      {children}
    </div>
  );
}
