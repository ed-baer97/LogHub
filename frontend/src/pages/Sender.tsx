import { useEffect, useMemo, useState, type FormEvent } from "react";
import Empty, { Skeleton } from "../components/Empty";
import MapView from "../components/MapView";
import OrderPanel from "../components/OrderPanel";
import { useToast } from "../components/Toast";
import { api, errText, streamUrl } from "../api";
import { STATUS_RU } from "../lib/labels";
import type { Order, Settlement, Vehicle } from "../types";

const PLACE_KINDS = [
  { id: "village", label: "Посёлок / точка" },
  { id: "industrial", label: "Промзона / склад" },
  { id: "construction", label: "Стройка" },
  { id: "city", label: "Город" },
];

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
  const [tab, setTab] = useState<"new" | "mine" | "places">("new");
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
  const [placeName, setPlaceName] = useState("");
  const [placeKind, setPlaceKind] = useState("village");
  const [placeNote, setPlaceNote] = useState("");
  const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(null);
  const [editPlace, setEditPlace] = useState<{ id: number; name: string; note: string } | null>(null);

  function reload() {
    api<Order[]>("/api/orders").then(setOrders);
    api<Settlement[]>("/api/geo/settlements").then(setSettlements);
    api<Vehicle[]>("/api/geo/vehicles").then(setVehicles).catch(() => setVehicles([]));
  }

  useEffect(() => {
    Promise.all([
      api<Settlement[]>("/api/geo/settlements"),
      api<Order[]>("/api/orders"),
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
    const es = new EventSource(streamUrl("/api/tracking/stream"));
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "fleet") setVehicles(data.vehicles ?? []);
      if (data.type === "order" || data.type === "order_new") reload();
    };
    return () => es.close();
  }, [toast]);

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

  async function cancelOrder(o: Order) {
    if (!window.confirm("Отменить заявку? История сохранится, борт освободится.")) return;
    try {
      await api(`/api/orders/${o.id}/cancel`, { method: "POST", body: "{}" });
      toast.ok("Заявка отменена");
      setSelected(null);
      reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  async function deleteOrder(o: Order) {
    if (!window.confirm("Удалить заявку без следа? Можно только пока её не взяли.")) return;
    try {
      await api(`/api/orders/${o.id}`, { method: "DELETE" });
      toast.ok("Заявка удалена");
      setSelected(null);
      reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  async function saveOpenOrder(o: Order) {
    try {
      await api(`/api/orders/${o.id}`, {
        method: "PATCH",
        body: JSON.stringify({ cargo_title: o.cargo_title, weight_kg: o.weight_kg }),
      });
      toast.ok("Заявка обновлена");
      reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  async function savePlace(e: FormEvent) {
    e.preventDefault();
    if (!editPlace) return;
    try {
      await api(`/api/geo/settlements/${editPlace.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editPlace.name.trim(), note: editPlace.note.trim() || null }),
      });
      toast.ok("Пункт обновлён");
      setEditPlace(null);
      reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  async function removePlace(id: number) {
    if (!window.confirm("Удалить свой пункт?")) return;
    try {
      await api(`/api/geo/settlements/${id}`, { method: "DELETE" });
      toast.ok("Пункт удалён");
      reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }
  async function addPlace(e: FormEvent) {
    e.preventDefault();
    if (!picked) {
      toast.err("Кликните по карте, чтобы поставить точку");
      return;
    }
    try {
      const created = await api<Settlement>("/api/geo/settlements", {
        method: "POST",
        body: JSON.stringify({
          name: placeName.trim(),
          kind: placeKind,
          lat: picked.lat,
          lon: picked.lon,
          note: placeNote.trim() || null,
        }),
      });
      toast.ok(`Пункт «${created.name}» добавлен`);
      setPlaceName("");
      setPlaceNote("");
      setPicked(null);
      reload();
      setOrigin(created.id);
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
          <button className={`tab${tab === "places" ? " active" : ""}`} onClick={() => setTab("places")}>
            Пункты
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
                  <div key={o.id} className={`card${selected?.id === o.id ? " selected" : ""}`}>
                    <button
                      type="button"
                      style={{ textAlign: "left", cursor: "pointer", color: "inherit", background: "none", border: 0, padding: 0, width: "100%" }}
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
                    {o.status === "open" || o.status === "taken" || o.status === "assigned" ? (
                      <div className="row-actions" style={{ marginTop: 8 }}>
                        {o.status === "open" ? (
                          <>
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => {
                                const next = window.prompt("Описание груза", o.cargo_title);
                                if (!next) return;
                                saveOpenOrder({ ...o, cargo_title: next });
                              }}
                            >
                              Изменить
                            </button>
                            <button type="button" className="btn small dust" onClick={() => deleteOrder(o)}>
                              Удалить
                            </button>
                          </>
                        ) : null}
                        <button type="button" className="btn small dust" onClick={() => cancelOrder(o)}>
                          Отменить
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {selected && <OrderPanel order={selected} onShowOnMap={() => showOnMap(selected)} />}
          </div>
        )}

        {tab === "places" && (
          <div style={{ marginTop: 16 }}>
            <form className="grid" onSubmit={addPlace}>
              <p className="lede">Справочник области общий. Свои точки можно править и удалять.</p>
              <label>
                Название
                <input
                  required
                  placeholder="например: склад у трассы"
                  value={placeName}
                  onChange={(e) => setPlaceName(e.target.value)}
                />
              </label>
              <label>
                Тип
                <select value={placeKind} onChange={(e) => setPlaceKind(e.target.value)}>
                  {PLACE_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Примечание
                <input value={placeNote} onChange={(e) => setPlaceNote(e.target.value)} />
              </label>
              <div className="hint">
                {picked
                  ? `${picked.lat.toFixed(5)}, ${picked.lon.toFixed(5)}`
                  : "Точка на карте ещё не выбрана"}
              </div>
              <button className="btn" type="submit" disabled={!picked || !placeName.trim()}>
                Сохранить пункт
              </button>
            </form>
            <h3 style={{ marginTop: 20 }}>Мои пункты</h3>
            {settlements.filter((s) => s.sender_id).length === 0 ? (
              <Empty title="Своих точек нет" hint="Кликните по карте и сохраните пункт." />
            ) : (
              <div className="card-list">
                {settlements
                  .filter((s) => s.sender_id)
                  .map((s) => (
                    <div className="card" key={s.id}>
                      {editPlace?.id === s.id ? (
                        <form className="grid" onSubmit={savePlace}>
                          <input
                            value={editPlace.name}
                            onChange={(e) => setEditPlace({ ...editPlace, name: e.target.value })}
                          />
                          <input
                            value={editPlace.note}
                            onChange={(e) => setEditPlace({ ...editPlace, note: e.target.value })}
                          />
                          <div className="row-actions">
                            <button className="btn small" type="submit">
                              Сохранить
                            </button>
                            <button type="button" className="btn small secondary" onClick={() => setEditPlace(null)}>
                              Отмена
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <h3>{s.name}</h3>
                          <div className="meta">
                            <span>{s.kind}</span>
                            {s.note ? <span>{s.note}</span> : null}
                          </div>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => setEditPlace({ id: s.id, name: s.name, note: s.note ?? "" })}
                            >
                              Изменить
                            </button>
                            <button type="button" className="btn small dust" onClick={() => removePlace(s.id)}>
                              Удалить
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </aside>
      <MapView
        settlements={settlements}
        vehicles={vehicles}
        routes={quoteRoute}
        trail={trail}
        onPick={tab === "places" ? (lat, lon) => setPicked({ lat, lon }) : undefined}
      />
    </div>
  );
}
