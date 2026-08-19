export type Role = "sender" | "carrier" | "driver" | "admin" | "superadmin" | "dispatcher";

export function isStaff(role: Role) {
  return role === "admin" || role === "superadmin" || role === "dispatcher";
}

export type User = {
  id: number;
  email: string;
  name: string;
  role: Role;
  company?: string | null;
  phone?: string | null;
};

export type Settlement = {
  id: number;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  population: number;
  note?: string | null;
};

export type Vehicle = {
  id: number;
  plate: string;
  kind: string;
  capacity_kg: number;
  owner_id: number;
  driver_name: string;
  status: string;
  lat: number;
  lon: number;
  heading: number;
  home_id: number;
  current_order_id?: number | null;
  live: boolean;
};

export type Order = {
  id: number;
  sender_id: number;
  origin_id: number;
  dest_id: number;
  origin_name: string;
  dest_name: string;
  cargo_type: string;
  cargo_title: string;
  weight_kg: number;
  price_offered: number;
  price_recommended: number;
  status: string;
  carrier_id?: number | null;
  vehicle_id?: number | null;
  distance_km: number;
  empty_km_saved: number;
  is_backhaul: boolean;
  created_at?: string | null;
  origin_lat: number;
  origin_lon: number;
  dest_lat: number;
  dest_lon: number;
  sender_name?: string | null;
  plate?: string | null;
};

export type MatchHint = {
  order_id: number;
  detour_km: number;
  empty_km_saved: number;
  fuel_saved_l: number;
  money_saved_kzt: number;
  reason: string;
  loaded_km?: number;
};

export type Analytics = {
  settlements: number;
  vehicles: number;
  open_orders: number;
  in_transit: number;
  delivered: number;
  loaded_km: number;
  empty_km_without_platform: number;
  empty_km_with_platform: number;
  empty_km_saved: number;
  fuel_saved_l: number;
  money_saved_kzt: number;
  empty_share_history: number;
  corridors: { from: string; to: string; trips: number; km: number }[];
  assumptions: {
    diesel_l_per_100km: number;
    diesel_kzt_per_l: number;
    empty_share_without: number;
  };
};
