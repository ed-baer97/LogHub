import type { Order, Vehicle } from "../types";

export const VEHICLE_KINDS = [
  { id: "tent", label: "тент" },
  { id: "reefer", label: "рефрижератор" },
  { id: "dump", label: "самосвал" },
  { id: "flatbed", label: "площадка" },
];

export type FleetUiStatus = "idle" | "assigned" | "loading" | "transit" | "inactive";

export const FLEET_STATUS_RU: Record<FleetUiStatus, string> = {
  idle: "Свободен",
  assigned: "Ожидает погрузку",
  loading: "На погрузке",
  transit: "В пути",
  inactive: "Неактивен",
};

export function tripForVehicle(v: Vehicle, trips: Order[]): Order | undefined {
  if (!v.current_order_id) return undefined;
  return trips.find((o) => o.id === v.current_order_id);
}

export function fleetUiStatus(v: Vehicle, trip?: Order): FleetUiStatus {
  if (v.active === false) return "inactive";
  const os = trip?.status;
  if (os === "transit") return "transit";
  if (os === "arrived" || os === "loading" || os === "pickup") return "loading";
  if (os === "assigned") return "assigned";
  if (v.status === "enroute") return "transit";
  if (v.status === "loading") return "loading";
  if (v.status === "assigned" || v.current_order_id) return "assigned";
  return "idle";
}

export function kindLabel(kind: string): string {
  return VEHICLE_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

export function formatKg(n: number): string {
  return `${n.toLocaleString("ru-RU")} кг`;
}

function toRad(d: number) {
  return (d * Math.PI) / 180;
}

export function kmBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function tripProgress(v: Vehicle, trip: Order): { pct: number; remainingKm: number; doneKm: number } | null {
  if (!(trip.distance_km > 0) || trip.dest_lat == null || trip.dest_lon == null) return null;
  if (v.lat == null || v.lon == null) return null;
  const remainingKm = kmBetween(v.lat, v.lon, trip.dest_lat, trip.dest_lon);
  const doneKm = Math.max(0, trip.distance_km - remainingKm);
  const pct = Math.max(0, Math.min(100, Math.round((doneKm / trip.distance_km) * 100)));
  return { pct, remainingKm, doneKm };
}
