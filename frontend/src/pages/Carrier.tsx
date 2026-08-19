import { useEffect, useMemo, useState } from "react";
import Empty, { Skeleton } from "../components/Empty";
import MapView from "../components/MapView";
import OrderPanel from "../components/OrderPanel";
import { useToast } from "../components/Toast";
import { api, errText } from "../api";
import { STATUS_RU } from "../lib/labels";
import type { MatchHint, Order, Settlement, User, Vehicle } from "../types";

export default function Carrier({ user }: { user: User }) {
  const toast = useToast();
  const [tab, setTab] = useState<"feed" | "mine">("feed");
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [vehicleId, setVehicleId] = useState(0);
  const [hints, setHints] = useState<MatchHint[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [routes, setRoutes] = useState<{ id: string; coords: number[][] }[]>([]);
  const [trail, setTrail] = useState<number[][]>([]);

  const mineFleet = useMemo(
    () => vehicles.filter((v) => v.owner_id === user.id),
    [vehicles, user.id]
  );
  const chosen = mineFleet.find((v) => v.id === vehicleId);

  async function load() {
    const [s, v, o] = await Promise.all([
      api<Settlement[]>("/api/geo/settlements"),
      api<Vehicle[]>("/api/geo/vehicles"),
      api<Order[]>("/api/orders"),
    ]);
    setSettlements(s);
    setVehicles(v);
    setOrders(o);
    const owned = v.filter((x) => x.owner_id === user.id);
    setVehicleId((cur) => cur || owned[0]?.id || 0);
  }

  useEffect(() => {
    load()
      .catch((e) => toast.err(errText(e)))
      .finally(() => setLoading(false));
    const es = new EventSource("/api/tracking/stream");
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "fleet") setVehicles(data.vehicles);
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (!vehicleId) return;
    api<MatchHint[]>(`/api/orders/hints/backhaul?vehicle_id=${vehicleId}`)
      .then(setHints)
      .catch(() => setHints([]));
  }, [vehicleId, orders]);

  async function showOnMap(o: Order) {
    setSelected(o);
    const r = await api<{ geometry: number[][] }>(`/api/orders/${o.id}/route`);
    setRoutes([{ id: String(o.id), coords: r.geometry }]);
    if (o.vehicle_id) {
      const pts = await api<{ lat: number; lon: number }[]>(`/api/tracking/${o.vehicle_id}/trail`);
      setTrail(pts.map((p) => [p.lon, p.lat]));
    } else setTrail([]);
  }

  async function take(o: Order) {
    if (!window.confirm(`Взять заказ ${o.origin_name} → ${o.dest_name} на ${chosen?.plate ?? "машину"}?`)) {
      return;
    }
    try {
      await api(`/api/orders/${o.id}/take`, {
        method: "POST",
        body: JSON.stringify({ vehicle_id: vehicleId }),
      });
      toast.ok("Заказ взят, машина выехала");
      await load();
      setTab("mine");
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  const open = orders.filter((o) => {
    if (o.status !== "open") return false;
    if (chosen && o.weight_kg > chosen.capacity_kg) return false;
    return true;
  });
  const myTrips = orders.filter((o) => o.carrier_id === user.id);
  const hintMap = Object.fromEntries(hints.map((h) => [h.order_id, h]));
  const list = tab === "feed" ? open : myTrips;

  return (
    <div className="page split">
      <aside className="side">
        <p className="kicker">Перевозчик</p>
        <h2 className="display" style={{ fontSize: 34 }}>
          Биржа заявок
        </h2>
        <label>
          Машина
          <select value={vehicleId} onChange={(e) => setVehicleId(Number(e.target.value))}>
            {mineFleet.map((v) => (
              <option key={v.id} value={v.id}>
                {v.plate} · {v.kind} · {v.capacity_kg} кг
              </option>
            ))}
          </select>
        </label>
        <div className="tabs">
          <button className={`tab${tab === "feed" ? " active" : ""}`} onClick={() => setTab("feed")}>
            Биржа
          </button>
          <button className={`tab${tab === "mine" ? " active" : ""}`} onClick={() => setTab("mine")}>
            Мои рейсы
          </button>
        </div>
        {tab === "feed" && hints[0] && (
          <div className="hint" style={{ marginTop: 12 }}>
            Лучшая попутка: заявка #{hints[0].order_id} — экономия {hints[0].empty_km_saved} км
            порожняка ({hints[0].fuel_saved_l} л / {hints[0].money_saved_kzt.toLocaleString("ru-KZ")} ₸).{" "}
            {hints[0].reason}
          </div>
        )}
        <div className="card-list" style={{ marginTop: 16 }}>
          {loading ? (
            <Skeleton />
          ) : list.length === 0 ? (
            <Empty
              title={tab === "feed" ? "Подходящих заявок нет" : "Рейсов пока нет"}
              hint={
                tab === "feed"
                  ? "Смените машину или подождите новую заявку на бирже."
                  : "Возьмите заказ на вкладке «Биржа»."
              }
            />
          ) : (
            list.map((o) => {
              const h = hintMap[o.id];
              return (
                <div key={o.id} className={`card${selected?.id === o.id ? " selected" : ""}`}>
                  {h && tab === "feed" && (
                    <span className="badge back">попутка · −{h.empty_km_saved} км</span>
                  )}{" "}
                  <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                  <h3>
                    {o.origin_name} → {o.dest_name}
                  </h3>
                  <div className="meta">
                    <span>{o.cargo_title}</span>
                    <span>{o.weight_kg} кг</span>
                    <span>{o.distance_km} км</span>
                    <span>{o.price_offered.toLocaleString("ru-KZ")} ₸</span>
                  </div>
                  {h && tab === "feed" && <p className="lede">{h.reason}</p>}
                  <div className="row-actions">
                    <button className="btn secondary small" onClick={() => showOnMap(o)}>
                      На карте
                    </button>
                    {tab === "feed" && (
                      <button className="btn small" onClick={() => take(o)}>
                        Взять заказ
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        {selected && <OrderPanel order={selected} onShowOnMap={() => showOnMap(selected)} />}
      </aside>
      <MapView settlements={settlements} vehicles={vehicles} routes={routes} trail={trail} />
    </div>
  );
}
