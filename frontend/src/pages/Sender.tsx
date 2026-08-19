import { useEffect, useMemo, useState, type FormEvent } from "react";
import Empty, { Skeleton } from "../components/Empty";
import MapView from "../components/MapView";
import OrderPanel from "../components/OrderPanel";
import { useToast } from "../components/Toast";
import { api, errText } from "../api";
import { STATUS_RU } from "../lib/labels";
import type { Order, Settlement, Vehicle } from "../types";

const CARGO = [
  { id: "general", label: "Сборный / продукты" },
  { id: "perishable", label: "Скоропорт (рефрижератор)" },
  { id: "construction", label: "Стройматериалы" },
  { id: "fuel", label: "ГСМ" },
  { id: "livestock", label: "С/х груз" },
];

type Quote = {
  distance_km: number;
  duration_min: number;
  price_recommended: number;
  geometry: number[][];
};

export default function Sender() {
  const toast = useToast();
  const [tab, setTab] = useState<"new" | "mine">("new");
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState(0);
  const [dest, setDest] = useState(0);
  const [cargo, setCargo] = useState("general");
  const [title, setTitle] = useState("");
  const [weight, setWeight] = useState(1000);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [selected, setSelected] = useState<Order | null>(null);
  const [routes, setRoutes] = useState<{ id: string; coords: number[][] }[]>([]);
  const [trail, setTrail] = useState<number[][]>([]);

  useEffect(() => {
    Promise.all([
      api<Settlement[]>("/api/geo/settlements"),
      api<Order[]>("/api/orders?mine=true"),
      api<Vehicle[]>("/api/geo/vehicles"),
    ])
      .then(([s, o, v]) => {
        setSettlements(s);
        setOrders(o);
        setVehicles(v);
        if (s[0]) setOrigin(s[0].id);
        if (s[1]) setDest(s[1].id);
      })
      .catch((e) => toast.err(errText(e)))
      .finally(() => setLoading(false));
  }, [toast]);

  function reload() {
    api<Order[]>("/api/orders?mine=true").then(setOrders);
  }

  useEffect(() => {
    if (!origin || !dest || origin === dest) {
      setQuote(null);
      return;
    }
    api<Quote>(
      `/api/orders/quote?origin_id=${origin}&dest_id=${dest}&weight_kg=${weight}&cargo_type=${cargo}`
    )
      .then(setQuote)
      .catch(() => setQuote(null));
  }, [origin, dest, weight, cargo]);

  async function showOnMap(o: Order) {
    setSelected(o);
    const r = await api<{ geometry: number[][] }>(`/api/orders/${o.id}/route`);
    setRoutes([{ id: String(o.id), coords: r.geometry }]);
    if (o.vehicle_id) {
      const pts = await api<{ lat: number; lon: number }[]>(`/api/tracking/${o.vehicle_id}/trail`);
      setTrail(pts.map((p) => [p.lon, p.lat]));
    } else setTrail([]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const created = await api<Order>("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          origin_id: origin,
          dest_id: dest,
          cargo_type: cargo,
          cargo_title: title.trim() || "Груз",
          weight_kg: weight,
          price_offered: quote?.price_recommended,
        }),
      });
      toast.ok("Заявка размещена на бирже");
      setTitle("");
      reload();
      setTab("mine");
      await showOnMap(created);
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  const quoteRoute = useMemo(
    () => (quote?.geometry?.length && tab === "new" ? [{ id: "quote", coords: quote.geometry }] : routes),
    [quote, tab, routes]
  );

  return (
    <div className="page split">
      <aside className="side">
        <p className="kicker">Отправитель</p>
        <h2 className="display" style={{ fontSize: 34 }}>
          Перевозка по области
        </h2>
        <div className="tabs">
          <button className={`tab${tab === "new" ? " active" : ""}`} onClick={() => setTab("new")}>
            Новая заявка
          </button>
          <button className={`tab${tab === "mine" ? " active" : ""}`} onClick={() => setTab("mine")}>
            Мои
          </button>
        </div>

        {tab === "new" && (
          <form className="grid" onSubmit={submit} style={{ marginTop: 16 }}>
            <p className="lede">Цена считается по километражу реальных дорог и типу груза.</p>
            <label>
              Откуда
              <select value={origin} onChange={(e) => setOrigin(Number(e.target.value))}>
                {settlements.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Куда
              <select value={dest} onChange={(e) => setDest(Number(e.target.value))}>
                {settlements.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Груз
              <select value={cargo} onChange={(e) => setCargo(e.target.value)}>
                {CARGO.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Описание
              <input
                placeholder="например: продукты в магазин Шетпе"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Вес, кг
              <input type="number" value={weight} onChange={(e) => setWeight(Number(e.target.value))} />
            </label>
            {quote && (
              <div className="hint">
                {quote.distance_km} км · ~{quote.duration_min} мин
                <br />
                Рекомендованная цена: <strong>{quote.price_recommended.toLocaleString("ru-KZ")} ₸</strong>
              </div>
            )}
            <button className="btn" type="submit" disabled={!origin || origin === dest}>
              Разместить на бирже
            </button>
          </form>
        )}

        {tab === "mine" && (
          <div style={{ marginTop: 16 }}>
            {loading ? (
              <Skeleton />
            ) : orders.length === 0 ? (
              <Empty title="Заявок пока нет" hint="Создайте первую перевозку на соседней вкладке." />
            ) : (
              <div className="card-list">
                {orders.map((o) => (
                  <button
                    key={o.id}
                    className={`card${selected?.id === o.id ? " selected" : ""}`}
                    style={{ textAlign: "left", cursor: "pointer", color: "inherit" }}
                    onClick={() => showOnMap(o)}
                  >
                    <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                    <h3>
                      {o.origin_name} → {o.dest_name}
                    </h3>
                    <div className="meta">
                      <span>{o.cargo_title}</span>
                      <span>{o.distance_km} км</span>
                      <span>{o.price_offered.toLocaleString("ru-KZ")} ₸</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {selected && <OrderPanel order={selected} onShowOnMap={() => showOnMap(selected)} />}
          </div>
        )}
      </aside>
      <MapView settlements={settlements} vehicles={vehicles} routes={quoteRoute} trail={trail} />
    </div>
  );
}
