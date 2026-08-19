import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";

export default function DriverShell({
  children,
  mapMode = false,
}: {
  children: ReactNode;
  mapMode?: boolean;
}) {
  return (
    <div className={`cabinet super-cabinet driver-cabinet${mapMode ? " map-mode" : ""}`}>
      <div className="cabinet-head">
        <div className="tabs">
          <NavLink to="/driver" end className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
            Рейс
          </NavLink>
          <NavLink to="/driver/history" className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
            История
          </NavLink>
          <NavLink to="/driver/profile" className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
            Профиль
          </NavLink>
        </div>
        <p className="kicker cabinet-role">Водитель</p>
      </div>
      {children}
    </div>
  );
}
