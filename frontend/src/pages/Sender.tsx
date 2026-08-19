import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BarList, ChartCard, DonutChart, MetricCard, SparkBars, ordersByDay, statusSlices } from "../components/Charts";
import Empty, { Skeleton } from "../components/Empty";
import MapView from "../components/MapView";
import OrderPanel from "../components/OrderPanel";
import { useToast } from "../components/Toast";
import { api, errText, streamUrl } from "../api";
import { formatKg } from "../lib/fleet";
import { fmtNum, orderCode } from "../lib/format";
import { PLACE_KIND_RU, STATUS_RU } from "../lib/labels";
import ProfileForm from "../components/ProfileForm";
import type { Order, Settlement, User, Vehicle } from "../types";

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

const CARGO_LABEL: Record<string, string> = Object.fromEntries(CARGO.map((c) => [c.id, c.label]));
const PAGE = 20;

type Tab = "overview" | "orders" | "places" | "analytics" | "profile";
type OrderFilter = "all" | "open" | "work" | "transit" | "delivered" | "cancelled";
type ConfirmKind = "cancel" | "delete" | "place";

type Quote = {
  distance_km: number;
  duration_min: number;
  price_recommended: number;
  geometry: number[][];
};

const ORDER_FILTERS: { id: OrderFilter; label: string; match: string[] }[] = [
  { id: "all", label: "Все", match: [] },
  { id: "open", label: "Открытые", match: ["open"] },
  { id: "work", label: "В работе", match: ["taken", "assigned", "arrived", "loading", "pickup"] },
  { id: "transit", label: "В рейсе", match: ["transit"] },
  { id: "delivered", label: "Доставлены", match: ["delivered"] },
  { id: "cancelled", label: "Отменены", match: ["cancelled"] },
];

function ownCorridors(orders: Order[]) {
  const byPair = new Map<string, { from: string; to: string; trips: number; km: number }>();
  for (const o of orders.filter((x) => x.status === "delivered" || x.status === "transit")) {
    const key = `${o.origin_name}|${o.dest_name}`;
    const slot = byPair.get(key) ?? { from: o.origin_name, to: o.dest_name, trips: 0, km: 0 };
    slot.trips += 1;
    slot.km += o.distance_km;
    byPair.set(key, slot);
  }
  return [...byPair.values()].sort((a, b) => b.km - a.km);
}

export default function Sender({ user, onUser }: { user: User; onUser: (user: User) => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("overview");
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const [panelOpen, setPanelOpen] = useState(true);
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE);
  const [menuId, setMenuId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; order?: Order; placeId?: number } | null>(null);
  const [editOrder, setEditOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      setLoadError(null);
      const [s, o, v] = await Promise.all([
        api<Settlement[]>("/api/geo/settlements"),
        api<Order[]>("/api/orders"),
        api<Vehicle[]>("/api/geo/vehicles").catch(() => [] as Vehicle[]),
      ]);
      setSettlements(s);
      setOrders(o);
      setVehicles(v);
      setOrigin((cur) => cur || s[0]?.id || 0);
      setDest((cur) => cur || s[1]?.id || 0);
    } catch (ex) {
      const text = errText(ex);
      setLoadError(text);
      toast.err(text);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    reload();
    const es = new EventSource(streamUrl("/api/tracking/stream"));
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { type?: string; vehicles?: Vehicle[] };
        if (data.type === "fleet") setVehicles(data.vehicles ?? []);
        if (data.type === "order" || data.type === "order_new") reload();
      } catch {
        /* keep last snapshot */
      }
    };
    return () => es.close();
  }, [reload]);

  useEffect(() => {
    if (!origin || !dest || origin === dest) {
      setQuote(null);
      return;
    }
    api<Quote>(`/api/orders/quote?origin_id=${origin}&dest_id=${dest}&weight_kg=${weight}&cargo_type=${cargo}`)
      .then(setQuote)
      .catch(() => setQuote(null));
  }, [origin, dest, weight, cargo]);

  useEffect(() => {
    setVisible(PAGE);
    setMenuId(null);
  }, [filter, query]);

  useEffect(() => {
    if (menuId == null) return;
    function onDoc(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuId(null);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuId]);

  async function showOnMap(o: Order) {
    setSelected(o);
    try {
      const r = await api<{ geometry: number[][] }>(`/api/orders/${o.id}/route`);
      setRoutes([{ id: String(o.id), coords: r.geometry }]);
      if (o.vehicle_id) {
        const pts = await api<{ lat: number; lon: number }[]>(`/api/tracking/${o.vehicle_id}/trail`);
        setTrail(pts.map((p) => [p.lon, p.lat]));
      } else setTrail([]);
    } catch (ex) {
      toast.err(errText(ex));
    }
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
      await reload();
      await showOnMap(created);
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  async function saveOpenOrder() {
    if (!editOrder) return;
    setBusy(true);
    try {
      await api(`/api/orders/${editOrder.id}`, {
        method: "PATCH",
        body: JSON.stringify({ cargo_title: editOrder.cargo_title, weight_kg: editOrder.weight_kg }),
      });
      toast.ok("Заявка обновлена");
      setEditOrder(null);
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    } finally {
      setBusy(false);
    }
  }

  async function applyConfirm() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "cancel" && confirm.order) {
        await api(`/api/orders/${confirm.order.id}/cancel`, { method: "POST", body: "{}" });
        toast.ok("Заявка отменена");
        setSelected(null);
      } else if (confirm.kind === "delete" && confirm.order) {
        await api(`/api/orders/${confirm.order.id}`, { method: "DELETE" });
        toast.ok("Заявка удалена");
        setSelected(null);
      } else if (confirm.kind === "place" && confirm.placeId) {
        await api(`/api/geo/settlements/${confirm.placeId}`, { method: "DELETE" });
        toast.ok("Пункт удалён");
      }
      setConfirm(null);
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    } finally {
      setBusy(false);
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
      await reload();
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
      await reload();
      setOrigin(created.id);
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  const quoteRoute = useMemo(
    () => (quote?.geometry?.length && tab === "overview" && !selected ? [{ id: "quote", coords: quote.geometry }] : routes),
    [quote, tab, routes, selected]
  );
  const myPlaces = settlements.filter((s) => s.sender_id);
  const openJobs = orders.filter((o) => o.status === "open");
  const transitJobs = orders.filter((o) => o.status === "transit");
  const mapMode = tab === "overview" || tab === "places";
  const fitTo = settlements.map((s) => [s.lon, s.lat]);

  const filteredOrders = useMemo(() => {
    const spec = ORDER_FILTERS.find((f) => f.id === filter);
    const byStatus = !spec || filter === "all" ? orders : orders.filter((o) => spec.match.includes(o.status));
    const q = query.trim().toLowerCase();
    const found = q
      ? byStatus.filter((o) =>
          `${o.origin_name} ${o.dest_name} ${o.cargo_title} ${orderCode(o.id)} ${o.plate ?? ""}`.toLowerCase().includes(q)
        )
      : byStatus;
    return [...found].sort((a, b) => b.id - a.id);
  }, [filter, orders, query]);
  const shownOrders = filteredOrders.slice(0, visible);

  const confirmCopy =
    confirm?.kind === "cancel"
      ? { title: "Отмена заявки", text: "Отменить заявку? История сохранится, борт освободится.", action: "Отменить" }
      : confirm?.kind === "delete"
        ? { title: "Удаление", text: "Удалить заявку без следа? Можно только пока её не взяли.", action: "Удалить" }
        : { title: "Удаление пункта", text: "Удалить свой пункт?", action: "Удалить" };

  return (
    <div className={`cabinet sender-cabinet${mapMode ? " map-mode" : ""}`}>
      <div className="cabinet-head">
        <div className="tabs">
          {(
            [
              ["overview", "Обзор"],
              ["orders", "Заявки"],
              ["places", "Пункты"],
              ["analytics", "Аналитика"],
              ["profile", "Профиль"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={`tab${tab === id ? " active" : ""}`}
              onClick={() => {
                setTab(id);
                setPanelOpen(true);
                if (id !== "overview") setSelected(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="kicker cabinet-role">Отправитель</p>
      </div>

      {loadError && orders.length === 0 && settlements.length === 0 ? (
        <Empty title="Не удалось загрузить кабинет" hint={loadError} />
      ) : (
        <>
          {tab === "overview" && (
            <div className="sender-stage">
              <MapView
                settlements={settlements}
                vehicles={vehicles}
                routes={quoteRoute}
                trail={trail}
                legend={vehicles.length ? "fleet" : "places"}
                fitTo={fitTo}
                fitMaxZoom={8.4}
                navPosition="bottom-right"
              />
              <button
                type="button"
                className={`btn small super-panel-toggle${panelOpen ? " on-panel" : ""}`}
                onClick={() => setPanelOpen((v) => !v)}
              >
                {panelOpen ? "Скрыть панели" : "Заявка"}
              </button>
              {panelOpen && (
                <div className="super-hud admin-hud">
                  <aside className="super-bar admin-dash">
                    <header className="admin-hero">
                      <h2 className="display">Новая заявка</h2>
                      <p className="lede">Цена считается по километражу реальных дорог и типу груза.</p>
                    </header>
                    <form className="grid" onSubmit={submit}>
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
                  </aside>
                  <aside className="super-side admin-jobs">
                    <section className="admin-panel">
                      <h3>Открытые</h3>
                      {loading && openJobs.length === 0 ? (
                        <Skeleton rows={2} />
                      ) : openJobs.length === 0 ? (
                        <Empty title="Нет открытых заявок" />
                      ) : (
                        <div className="job-stack">
                          {openJobs.map((o) => (
                            <button
                              type="button"
                              className={`job-card${selected?.id === o.id ? " selected" : ""}`}
                              key={o.id}
                              onClick={() => showOnMap(o)}
                            >
                              <header className="job-card-head">
                                <span className="job-status">
                                  <i className="status-dot open" />
                                  Открыта
                                </span>
                                <span className="job-id">{orderCode(o.id)}</span>
                              </header>
                              <h4>
                                {o.origin_name} → {o.dest_name}
                              </h4>
                              <p>{o.cargo_title}</p>
                            </button>
                          ))}
                        </div>
                      )}
                    </section>
                    <section className="admin-panel">
                      <h3>В рейсе</h3>
                      {transitJobs.length === 0 ? (
                        <Empty title="Нет рейсов в пути" />
                      ) : (
                        <div className="job-stack">
                          {transitJobs.map((o) => (
                            <button
                              type="button"
                              className={`job-card${selected?.id === o.id ? " selected" : ""}`}
                              key={o.id}
                              onClick={() => showOnMap(o)}
                            >
                              <header className="job-card-head">
                                <span className="job-status">
                                  <i className="status-dot transit" />
                                  В рейсе
                                </span>
                                <span className="job-id">{orderCode(o.id)}</span>
                              </header>
                              <h4>
                                {o.origin_name} → {o.dest_name}
                              </h4>
                              <p>{o.cargo_title}</p>
                              {o.plate ? <p className="meta">{o.plate}</p> : null}
                            </button>
                          ))}
                        </div>
                      )}
                    </section>
                    {selected && <OrderPanel order={selected} onShowOnMap={() => showOnMap(selected)} />}
                  </aside>
                </div>
              )}
            </div>
          )}

          {tab === "orders" && (
            <div className="users-page">
              <div className="users-toolbar">
                <div className="users-toolbar-head">
                  <div>
                    <h2 className="display cabinet-title" style={{ display: "block", fontSize: 28, margin: 0 }}>
                      Мои заявки
                    </h2>
                    <p className="lede" style={{ margin: "6px 0 0" }}>
                      {filteredOrders.length} в списке
                    </p>
                  </div>
                  <button type="button" className="btn small" onClick={() => setTab("overview")}>
                    Новая заявка
                  </button>
                </div>
                <div className="users-toolbar-row">
                  <div className="tabs">
                    {ORDER_FILTERS.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className={`tab${filter === f.id ? " active" : ""}`}
                        onClick={() => setFilter(f.id)}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Поиск заявки..."
                  aria-label="Поиск заявки"
                />
              </div>
              {loading && orders.length === 0 ? (
                <Skeleton rows={4} />
              ) : shownOrders.length === 0 ? (
                <Empty
                  title="Заявок пока нет"
                  hint={query || filter !== "all" ? "Попробуйте изменить запрос или фильтр." : "Создайте перевозку во вкладке Обзор."}
                />
              ) : (
                <>
                  <div className="table-scroll">
                    <table className="data-table compact-table users-table">
                      <thead>
                        <tr>
                          <th>Заявка</th>
                          <th>Груз</th>
                          <th className="num">Км</th>
                          <th className="num">₸</th>
                          <th>Статус</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownOrders.map((o) => {
                          const canEdit = o.status === "open";
                          const canCancel = o.status === "open" || o.status === "taken" || o.status === "assigned";
                          return (
                            <tr key={o.id}>
                              <td>
                                <div className="user-cell">
                                  <strong>
                                    {o.origin_name} → {o.dest_name}
                                  </strong>
                                  <span>
                                    {orderCode(o.id)}
                                    {o.is_backhaul ? " · обратка" : ""}
                                    {o.plate ? ` · ${o.plate}` : ""}
                                  </span>
                                </div>
                              </td>
                              <td>
                                <div className="user-cell">
                                  <span>{o.cargo_title}</span>
                                  <span>{formatKg(o.weight_kg)}</span>
                                </div>
                              </td>
                              <td className="num">{fmtNum(o.distance_km)}</td>
                              <td className="num">{o.price_offered.toLocaleString("ru-KZ")}</td>
                              <td>
                                <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                              </td>
                              <td className="row-menu-cell">
                                <div className="row-menu-wrap" ref={menuId === o.id ? menuRef : undefined}>
                                  <button
                                    type="button"
                                    className="row-menu-btn"
                                    aria-label="Действия"
                                    onClick={() => setMenuId((id) => (id === o.id ? null : o.id))}
                                  >
                                    ⋯
                                  </button>
                                  {menuId === o.id && (
                                    <div className="row-menu">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setMenuId(null);
                                          setTab("overview");
                                          setPanelOpen(true);
                                          showOnMap(o);
                                        }}
                                      >
                                        На карте
                                      </button>
                                      {canEdit && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setMenuId(null);
                                            setEditOrder({ ...o });
                                          }}
                                        >
                                          Изменить
                                        </button>
                                      )}
                                      {canCancel && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setMenuId(null);
                                            setConfirm({ kind: "cancel", order: o });
                                          }}
                                        >
                                          Отменить
                                        </button>
                                      )}
                                      {canEdit && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setMenuId(null);
                                            setConfirm({ kind: "delete", order: o });
                                          }}
                                        >
                                          Удалить
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {filteredOrders.length > visible && (
                    <button type="button" className="btn secondary small text-btn" onClick={() => setVisible((n) => n + PAGE)}>
                      Показать ещё · {filteredOrders.length - visible}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "places" && (
            <div className="sender-stage">
              <MapView
                settlements={settlements}
                vehicles={[]}
                routes={[]}
                legend="places"
                fitTo={fitTo}
                fitMaxZoom={8.4}
                navPosition="bottom-right"
                onPick={(lat, lon) => setPicked({ lat, lon })}
              />
              <button
                type="button"
                className={`btn small super-panel-toggle${panelOpen ? " on-panel" : ""}`}
                onClick={() => setPanelOpen((v) => !v)}
              >
                {panelOpen ? "Скрыть панели" : "Пункты"}
              </button>
              {panelOpen && (
                <div className="super-hud admin-hud">
                  <aside className="super-bar admin-dash">
                    <header className="admin-hero">
                      <h2 className="display">Новый пункт</h2>
                      <p className="lede">Справочник области общий. Свои точки можно править и удалять. Кликните по карте.</p>
                    </header>
                    <form className="grid" onSubmit={addPlace}>
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
                        {picked ? `${picked.lat.toFixed(5)}, ${picked.lon.toFixed(5)}` : "Точка на карте ещё не выбрана"}
                      </div>
                      <button className="btn" type="submit" disabled={!picked || !placeName.trim()}>
                        Сохранить пункт
                      </button>
                    </form>
                  </aside>
                  <aside className="super-side admin-jobs">
                    <section className="admin-panel">
                      <h3>Мои пункты</h3>
                      {myPlaces.length === 0 ? (
                        <Empty title="Своих точек нет" hint="Кликните по карте и сохраните пункт." />
                      ) : (
                        <div className="job-stack">
                          {myPlaces.map((s) => (
                            <article className="job-card" key={s.id}>
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
                                  <h4>{s.name}</h4>
                                  <p className="meta">
                                    {PLACE_KIND_RU[s.kind] ?? s.kind}
                                    {s.note ? ` · ${s.note}` : ""}
                                  </p>
                                  <div className="row-actions">
                                    <button
                                      type="button"
                                      className="btn small"
                                      onClick={() => setEditPlace({ id: s.id, name: s.name, note: s.note ?? "" })}
                                    >
                                      Изменить
                                    </button>
                                    <button
                                      type="button"
                                      className="btn small dust"
                                      onClick={() => setConfirm({ kind: "place", placeId: s.id })}
                                    >
                                      Удалить
                                    </button>
                                  </div>
                                </>
                              )}
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  </aside>
                </div>
              )}
            </div>
          )}

          {tab === "analytics" && <SenderAnalytics orders={orders} loading={loading} />}
          {tab === "profile" && (
            <ProfileForm user={user} onUser={onUser} note="Имя, почта, телефон и пароль. Заявки и пункты здесь не меняются." />
          )}
        </>
      )}

      {editOrder && (
        <div className="modal-backdrop" onClick={() => !busy && setEditOrder(null)} role="presentation">
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <p className="kicker">{orderCode(editOrder.id)}</p>
            <h2 className="display" style={{ fontSize: 26 }}>
              Изменить заявку
            </h2>
            <form
              className="grid"
              onSubmit={(e) => {
                e.preventDefault();
                saveOpenOrder();
              }}
            >
              <label>
                Описание
                <input
                  required
                  value={editOrder.cargo_title}
                  onChange={(e) => setEditOrder({ ...editOrder, cargo_title: e.target.value })}
                />
              </label>
              <label>
                Вес, кг
                <input
                  type="number"
                  required
                  value={editOrder.weight_kg}
                  onChange={(e) => setEditOrder({ ...editOrder, weight_kg: Number(e.target.value) })}
                />
              </label>
              <div className="row-actions">
                <button className="btn" type="submit" disabled={busy}>
                  Сохранить
                </button>
                <button className="btn secondary" type="button" disabled={busy} onClick={() => setEditOrder(null)}>
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirm && (
        <div className="modal-backdrop" onClick={() => !busy && setConfirm(null)} role="presentation">
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <p className="kicker">{confirmCopy.title}</p>
            <h2 className="display" style={{ fontSize: 26 }}>
              {confirm.order ? `${confirm.order.origin_name} → ${confirm.order.dest_name}` : "Пункт"}
            </h2>
            <p className="lede">{confirmCopy.text}</p>
            <div className="row-actions">
              <button className="btn" type="button" disabled={busy} onClick={applyConfirm}>
                {confirmCopy.action}
              </button>
              <button className="btn secondary" type="button" disabled={busy} onClick={() => setConfirm(null)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SenderAnalytics({ orders, loading }: { orders: Order[]; loading: boolean }) {
  const delivered = orders.filter((o) => o.status === "delivered");
  const open = orders.filter((o) => o.status === "open").length;
  const transit = orders.filter((o) => o.status === "transit").length;
  const backhaul = orders.filter((o) => o.is_backhaul).length;
  const loadedKm = delivered.reduce((s, o) => s + o.distance_km, 0);
  const savedKm = orders.reduce((s, o) => s + (o.empty_km_saved || 0), 0);
  const spent = delivered.reduce((s, o) => s + o.price_offered, 0);
  const slices = useMemo(() => statusSlices(orders), [orders]);
  const days = useMemo(() => ordersByDay(orders), [orders]);
  const corridors = useMemo(() => ownCorridors(orders), [orders]);
  const cargoBars = useMemo(() => {
    const by = new Map<string, number>();
    for (const o of orders) {
      const key = CARGO_LABEL[o.cargo_type] ?? o.cargo_type;
      by.set(key, (by.get(key) ?? 0) + 1);
    }
    return [...by.entries()].map(([label, value]) => ({ label, value, tone: "sea" }));
  }, [orders]);

  if (loading && orders.length === 0) return <Skeleton rows={4} />;
  if (orders.length === 0) {
    return (
      <div className="analytics-page">
        <header className="admin-hero">
          <h2 className="display">Аналитика</h2>
          <p className="lede">Ваши перевозки внутри Мангистауской области.</p>
        </header>
        <Empty title="Пока нет заявок" hint="После первых рейсов здесь появятся графики." />
      </div>
    );
  }

  return (
    <div className="analytics-page">
      <header className="admin-hero">
        <h2 className="display">Аналитика</h2>
        <p className="lede">Ваши перевозки внутри Мангистауской области.</p>
      </header>
      <section>
        <h3 className="analytics-kicker">Перевозки</h3>
        <div className="metric-grid">
          <MetricCard name="С грузом" value={fmtNum(loadedKm)} unit="км" />
          <MetricCard name="Порожняк сэкономлен" value={fmtNum(savedKm)} unit="км" />
          <MetricCard name="Оплачено" value={fmtNum(spent)} unit="₸" />
          <MetricCard name="Обратки" value={fmtNum(backhaul)} unit="заявок" />
        </div>
      </section>
      <section>
        <h3 className="analytics-kicker">Сейчас</h3>
        <div className="metric-grid analytics-now">
          <MetricCard name="Открытые" value={fmtNum(open)} unit="заявок" />
          <MetricCard name="В рейсе" value={fmtNum(transit)} unit="рейсов" />
          <MetricCard name="Доставлено" value={fmtNum(delivered.length)} unit="рейсов" />
          <MetricCard name="Всего" value={fmtNum(orders.length)} unit="заявок" />
        </div>
      </section>
      <div className="chart-grid">
        <ChartCard title="Коридоры, км">
          <BarList
            items={corridors.map((c) => ({ label: `${c.from} → ${c.to}`, value: c.km, tone: "sea" }))}
            unit="км"
          />
        </ChartCard>
        <ChartCard title="Статусы заявок">
          <DonutChart slices={slices} />
        </ChartCard>
        <ChartCard title="Типы груза">
          <BarList items={cargoBars} />
        </ChartCard>
        <ChartCard title="Прямые и обратки">
          <BarList
            items={[
              { label: "Прямые", value: orders.length - backhaul, tone: "sea" },
              { label: "Обратки", value: backhaul, tone: "coral" },
            ]}
          />
        </ChartCard>
        {days.length > 0 && (
          <ChartCard title="Заявки за 14 дней">
            <SparkBars points={days} />
          </ChartCard>
        )}
      </div>
    </div>
  );
}
