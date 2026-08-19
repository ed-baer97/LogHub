import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Empty, { Skeleton } from "../components/Empty";
import MapView from "../components/MapView";
import { useToast } from "../components/Toast";
import { api, errText, streamUrl } from "../api";
import FleetBoard from "../components/FleetBoard";
import { STATUS_RU } from "../lib/labels";
import type { MatchHint, Order, Settlement, User, Vehicle } from "../types";

type Tab = "dash" | "feed" | "mine" | "fleet";
type Info = "open" | "trips" | "fleet" | "live" | "transit";

export default function Carrier({ user }: { user: User }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("dash");
  const [info, setInfo] = useState<Info | null>(null);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [hints, setHints] = useState<MatchHint[]>([]);
  const [routes, setRoutes] = useState<{ id: string; coords: number[][] }[]>([]);
  const [assign, setAssign] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);

  const mineFleet = useMemo(
    () => vehicles.filter((v) => v.owner_id === user.id),
    [vehicles, user.id]
  );
  const open = useMemo(() => orders.filter((o) => o.status === "open"), [orders]);
  const myTrips = useMemo(() => orders.filter((o) => o.carrier_id === user.id), [orders, user.id]);
  const idleBoards = mineFleet.filter((v) => v.driver_id && !v.current_order_id && v.active !== false);
  const hintMap = Object.fromEntries(hints.map((h) => [h.order_id, h]));

  const load = useCallback(async () => {
    const [s, v, o] = await Promise.all([
      api<Settlement[]>("/api/geo/settlements"),
      api<Vehicle[]>("/api/geo/vehicles"),
      api<Order[]>("/api/orders"),
    ]);
    setSettlements(s);
    setVehicles(v);
    setOrders(o);
    const active = o.filter((x) => x.carrier_id === user.id && x.status === "transit");
    const lines = await Promise.all(
      active.map(async (item) => {
        const r = await api<{ geometry: number[][] }>(`/api/orders/${item.id}/route`);
        return { id: String(item.id), coords: r.geometry };
      })
    );
    setRoutes(lines);
  }, [user.id]);

  useEffect(() => {
    load()
      .catch((e) => toast.err(errText(e)))
      .finally(() => setLoading(false));
    const es = new EventSource(streamUrl("/api/tracking/stream"));
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "fleet") setVehicles(data.vehicles ?? []);
      if (data.type === "order" || data.type === "order_new") load().catch(() => undefined);
    };
    return () => es.close();
  }, [load, toast]);

  useEffect(() => {
    api<MatchHint[]>("/api/orders/hints/backhaul")
      .then(setHints)
      .catch(() => setHints([]));
  }, [orders, mineFleet.length]);

  async function take(o: Order) {
    if (!window.confirm(`Взять заказ ${o.origin_name} → ${o.dest_name} на компанию?`)) return;
    try {
      await api(`/api/orders/${o.id}/take`, { method: "POST", body: "{}" });
      toast.ok("Заказ у вас. Назначьте борт во вкладке «Рейсы».");
      await load();
      setInfo(null);
      setTab("mine");
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  async function assignBort(o: Order) {
    const vehicleId = assign[o.id];
    if (!vehicleId) return;
    try {
      await api(`/api/orders/${o.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ vehicle_id: vehicleId }),
      });
      toast.ok("Борт назначен");
      await load();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "dash", label: "Дашборд" },
    { id: "feed", label: "Биржа" },
    { id: "mine", label: "Рейсы" },
    { id: "fleet", label: "Парк" },
  ];
  const mapMode = (tab === "dash" && !info) || tab === "feed" || tab === "mine";

  return (
    <div className={`cabinet super-cabinet${mapMode ? " map-mode" : ""}`}>
      <div className="cabinet-head">
        <div>
          <p className="kicker">Перевозчик{user.company ? ` · ${user.company}` : ""}</p>
          <h2 className="display cabinet-title">Кабинет парка</h2>
        </div>
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id && !info ? " active" : ""}`}
              onClick={() => {
                setInfo(null);
                setTab(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "dash" && info && (
        <div className="super-body">
          <CarrierInfo
            kind={info}
            open={open}
            trips={myTrips}
            fleet={mineFleet}
            settlements={settlements}
            idleBoards={idleBoards}
            hintMap={hintMap}
            assign={assign}
            setAssign={setAssign}
            onBack={() => setInfo(null)}
            onTake={take}
            onAssign={assignBort}
            onReload={load}
          />
        </div>
      )}

      {tab === "dash" && !info && (
        <CarrierDash
          settlements={settlements}
          vehicles={mineFleet}
          routes={routes}
          open={open}
          trips={myTrips}
          hints={hints}
          loading={loading}
          onOpenInfo={setInfo}
          onOpenTab={(id) => {
            setInfo(null);
            setTab(id);
          }}
        />
      )}

      {tab === "feed" && (
        <ExchangeBoard
          orders={open}
          hintMap={hintMap}
          loading={loading}
          onTake={take}
        />
      )}

      {tab === "mine" && (
        <TripsBoard
          orders={myTrips}
          vehicles={mineFleet}
          idleBoards={idleBoards}
          assign={assign}
          setAssign={setAssign}
          loading={loading}
          onAssign={assignBort}
        />
      )}

      {tab === "fleet" && (
        <div className="super-body">
          <FleetBoard
            vehicles={mineFleet}
            trips={myTrips}
            settlements={settlements}
            reload={load}
            onOpenTrip={() => {
              setInfo(null);
              setTab("mine");
            }}
          />
        </div>
      )}
    </div>
  );
}

function CarrierDash({
  settlements,
  vehicles,
  routes,
  open,
  trips,
  hints,
  loading,
  onOpenInfo,
  onOpenTab,
}: {
  settlements: Settlement[];
  vehicles: Vehicle[];
  routes: { id: string; coords: number[][] }[];
  open: Order[];
  trips: Order[];
  hints: MatchHint[];
  loading: boolean;
  onOpenInfo: (kind: Info) => void;
  onOpenTab: (tab: Tab) => void;
}) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [barDocked, setBarDocked] = useState(false);
  const live = vehicles.filter((v) => v.live).length;
  const idle = vehicles.filter((v) => v.active !== false && !v.current_order_id).length;
  const inTrip = trips.filter((o) => o.status === "transit").length;
  const savedKm = hints.reduce((s, h) => s + h.empty_km_saved, 0);
  const savedFuel = hints.reduce((s, h) => s + h.fuel_saved_l, 0);
  const savedMoney = hints.reduce((s, h) => s + h.money_saved_kzt, 0);
  const now = trips.filter((o) => !["delivered", "cancelled"].includes(o.status)).slice(0, 6);

  return (
    <div className="super-dash">
      <MapView settlements={settlements} vehicles={vehicles} routes={routes} navPosition="bottom-right" />
      <button
        type="button"
        className={`btn small super-panel-toggle${panelOpen ? " on-panel" : ""}`}
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={panelOpen}
      >
        {panelOpen ? "Скрыть панели" : "Показатели"}
      </button>
      {panelOpen && (
        <div className="super-hud">
          <aside className={`super-bar${barDocked ? " docked" : ""}`}>
            <button
              type="button"
              className="super-bar-dock"
              onClick={() => setBarDocked((v) => !v)}
              aria-label={barDocked ? "Показать показатели" : "Убрать влево"}
              title={barDocked ? "Показать" : "Убрать влево"}
            >
              {barDocked ? "›" : "‹"}
            </button>
            <div className="super-bar-block">
              <h3>Парк и биржа</h3>
              <div className="stats fit">
                <button type="button" className="stat stat-link" onClick={() => onOpenInfo("open")}>
                  <b>{open.length}</b>
                  <span>на бирже</span>
                </button>
                <button type="button" className="stat stat-link" onClick={() => onOpenInfo("trips")}>
                  <b>{trips.length}</b>
                  <span>моих рейсов</span>
                </button>
                <button type="button" className="stat stat-link" onClick={() => onOpenInfo("fleet")}>
                  <b>{vehicles.length}</b>
                  <span>бортов</span>
                </button>
                <button type="button" className="stat stat-link" onClick={() => onOpenTab("fleet")}>
                  <b>{idle}</b>
                  <span>свободных</span>
                </button>
                <button type="button" className="stat stat-link" onClick={() => onOpenInfo("transit")}>
                  <b>{inTrip}</b>
                  <span>в пути</span>
                </button>
                <button type="button" className="stat stat-link" onClick={() => onOpenInfo("live")}>
                  <b>{live}</b>
                  <span>live GPS</span>
                </button>
              </div>
            </div>
            <div className="super-bar-block">
              <h3>Попутки</h3>
              <div className="stats eco">
                <div className="stat">
                  <b>{savedKm.toFixed(0)}</b>
                  <span>км порожняка</span>
                </div>
                <div className="stat">
                  <b>{savedFuel.toFixed(0)} л</b>
                  <span>дизель</span>
                </div>
                <div className="stat">
                  <b>{savedMoney.toLocaleString("ru-KZ")} ₸</b>
                  <span>топливо</span>
                </div>
              </div>
            </div>
          </aside>
          <aside className="super-side">
            <h3>Активные рейсы</h3>
            {loading ? (
              <Skeleton rows={3} />
            ) : (
              <div className="card-list">
                {now.length === 0 ? (
                  <Empty title="Нет активных рейсов" hint="Возьмите заявку с биржи." />
                ) : (
                  now.map((o) => (
                    <div className="card" key={o.id}>
                      <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                      {o.is_backhaul && <span className="badge back">обратка</span>}
                      <h3>
                        {o.origin_name} → {o.dest_name}
                      </h3>
                      <div className="meta">
                        <span>{o.cargo_title}</span>
                        <span>{o.plate ?? "нужен борт"}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
            {hints[0] && (
              <>
                <h3 style={{ marginTop: 16 }}>Лучшая попутка</h3>
                <div className="card">
                  <span className="badge back">−{hints[0].empty_km_saved} км</span>
                  <h3>Заявка #{hints[0].order_id}</h3>
                  <p className="lede">{hints[0].reason}</p>
                  <button type="button" className="btn small" onClick={() => onOpenTab("feed")}>
                    К бирже
                  </button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function CarrierInfo({
  kind,
  open,
  trips,
  fleet,
  settlements,
  idleBoards,
  hintMap,
  assign,
  setAssign,
  onBack,
  onTake,
  onAssign,
  onReload,
}: {
  kind: Info;
  open: Order[];
  trips: Order[];
  fleet: Vehicle[];
  settlements: Settlement[];
  idleBoards: Vehicle[];
  hintMap: Record<number, MatchHint>;
  assign: Record<number, number>;
  setAssign: (v: Record<number, number>) => void;
  onBack: () => void;
  onTake: (o: Order) => void;
  onAssign: (o: Order) => void;
  onReload: () => Promise<void>;
}) {
  const titles: Record<Info, string> = {
    open: "Биржа",
    trips: "Мои рейсы",
    fleet: "Борты",
    live: "Live GPS",
    transit: "В пути",
  };
  const jobs =
    kind === "open" ? open : kind === "trips" ? trips : kind === "transit" ? trips.filter((o) => o.status === "transit") : null;
  const boards = kind === "fleet" ? fleet : kind === "live" ? fleet.filter((v) => v.live) : null;

  return (
    <div>
      <div className="row-actions" style={{ marginBottom: 14 }}>
        <button type="button" className="btn secondary small" onClick={onBack}>
          ← К карте
        </button>
      </div>
      <h2 className="display cabinet-title" style={{ display: "block", fontSize: 28, marginBottom: 16 }}>
        {titles[kind]}
      </h2>
      {jobs && (
        <OrdersTable
          orders={jobs}
          hintMap={hintMap}
          idleBoards={idleBoards}
          assign={assign}
          setAssign={setAssign}
          showTake={kind === "open"}
          showAssign={kind === "trips"}
          onTake={onTake}
          onAssign={onAssign}
        />
      )}
      {boards && (
        <FleetBoard
          compact
          vehicles={boards}
          trips={trips}
          settlements={settlements}
          reload={onReload}
        />
      )}
    </div>
  );
}

function pointsOf(o: Order): Settlement[] {
  return [
    {
      id: o.origin_id,
      name: `A · ${o.origin_name}`,
      kind: "city",
      lat: o.origin_lat,
      lon: o.origin_lon,
      population: 0,
      note: "Погрузка",
    },
    {
      id: o.dest_id === o.origin_id ? -o.dest_id : o.dest_id,
      name: `B · ${o.dest_name}`,
      kind: "industrial",
      lat: o.dest_lat,
      lon: o.dest_lon,
      population: 0,
      note: "Выгрузка",
    },
  ];
}

function ExchangeBoard({
  orders,
  hintMap,
  loading,
  onTake,
}: {
  orders: Order[];
  hintMap: Record<number, MatchHint>;
  loading: boolean;
  onTake: (o: Order) => void;
}) {
  const toast = useToast();
  const cache = useRef<Record<number, number[][]>>({});
  const shownId = useRef(0);
  const [selected, setSelected] = useState<Order | null>(null);
  const [preview, setPreview] = useState<{ id: string; coords: number[][] }[]>([]);

  async function showOrder(o: Order) {
    if (shownId.current === o.id) return;
    shownId.current = o.id;
    setSelected(o);
    try {
      if (!cache.current[o.id]) {
        const r = await api<{ geometry: number[][] }>(`/api/orders/${o.id}/route`);
        cache.current[o.id] = r.geometry ?? [];
      }
      if (shownId.current !== o.id) return;
      setPreview([{ id: String(o.id), coords: cache.current[o.id] }]);
    } catch (ex) {
      if (shownId.current !== o.id) return;
      setPreview([]);
      toast.err(errText(ex));
    }
  }

  const ab = selected ? pointsOf(selected) : [];
  const fitTo = useMemo(() => {
    if (!selected) return undefined;
    return [
      [selected.origin_lon, selected.origin_lat],
      [selected.dest_lon, selected.dest_lat],
      ...(preview[0]?.coords ?? []).filter((_, i) => i % 8 === 0),
    ];
  }, [selected, preview]);

  return (
    <div className="super-dash">
      <MapView
        settlements={ab}
        vehicles={[]}
        routes={preview}
        fitTo={fitTo}
        navPosition="bottom-right"
      />
      <div className="super-hud exchange-hud">
        <aside className="super-side">
          <h3>Биржа</h3>
          <p className="lede" style={{ marginTop: 0 }}>
            Наведите или нажмите заявку — на карте точки A, B и маршрут.
          </p>
          {loading ? (
            <Skeleton rows={4} />
          ) : orders.length === 0 ? (
            <Empty title="Открытых заявок нет" hint="Когда отправитель разместит груз, он появится здесь." />
          ) : (
            <div className="card-list">
              {orders.map((o) => {
                const h = hintMap[o.id];
                return (
                  <div
                    key={o.id}
                    className={`card${selected?.id === o.id ? " selected" : ""}`}
                    onMouseEnter={() => showOrder(o)}
                    onClick={() => showOrder(o)}
                    style={{ cursor: "pointer" }}
                  >
                    {h && <span className="badge back">попутка · −{h.empty_km_saved} км</span>}{" "}
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
                    {h && <p className="lede">{h.reason}</p>}
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn small"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTake(o);
                        }}
                      >
                        Взять
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function TripsBoard({
  orders,
  vehicles,
  idleBoards,
  assign,
  setAssign,
  loading,
  onAssign,
}: {
  orders: Order[];
  vehicles: Vehicle[];
  idleBoards: Vehicle[];
  assign: Record<number, number>;
  setAssign: (v: Record<number, number>) => void;
  loading: boolean;
  onAssign: (o: Order) => void;
}) {
  const toast = useToast();
  const cache = useRef<Record<number, number[][]>>({});
  const trailCache = useRef<Record<number, number[][]>>({});
  const shownId = useRef(0);
  const [selected, setSelected] = useState<Order | null>(null);
  const [preview, setPreview] = useState<{ id: string; coords: number[][] }[]>([]);
  const [trail, setTrail] = useState<number[][]>([]);

  async function showTrip(o: Order) {
    const same = shownId.current === o.id;
    shownId.current = o.id;
    setSelected(o);
    try {
      if (!cache.current[o.id]) {
        const r = await api<{ geometry: number[][] }>(`/api/orders/${o.id}/route`);
        cache.current[o.id] = r.geometry ?? [];
      }
      if (shownId.current !== o.id) return;
      setPreview([{ id: String(o.id), coords: cache.current[o.id] }]);
      if (o.vehicle_id && (o.status === "transit" || o.status === "loading" || o.status === "arrived")) {
        if (!same || !trailCache.current[o.id]) {
          const pts = await api<{ lat: number; lon: number }[]>(`/api/tracking/${o.vehicle_id}/trail`);
          trailCache.current[o.id] = pts.map((p) => [p.lon, p.lat]);
        }
        if (shownId.current !== o.id) return;
        setTrail(trailCache.current[o.id] ?? []);
      } else {
        setTrail([]);
      }
    } catch (ex) {
      if (shownId.current !== o.id) return;
      if (!same) {
        setPreview([]);
        setTrail([]);
      }
      toast.err(errText(ex));
    }
  }

  const bort =
    selected &&
    (vehicles.find((v) => v.id === selected.vehicle_id) ??
      vehicles.find((v) => v.current_order_id === selected.id));
  const mapVehicles = bort ? [bort] : [];
  const ab = selected ? pointsOf(selected) : [];
  const fitTo = useMemo(() => {
    if (!selected) return undefined;
    return [
      [selected.origin_lon, selected.origin_lat],
      [selected.dest_lon, selected.dest_lat],
      ...(preview[0]?.coords ?? []).filter((_, i) => i % 8 === 0),
    ];
  }, [selected, preview]);

  return (
    <div className="super-dash">
      <MapView
        settlements={ab}
        vehicles={mapVehicles}
        routes={preview}
        trail={trail}
        fitTo={fitTo}
        navPosition="bottom-right"
      />
      <div className="super-hud exchange-hud">
        <aside className="super-side">
          <h3>Мои рейсы</h3>
          <p className="lede" style={{ marginTop: 0 }}>
            Выберите рейс — маршрут A→B и текущая позиция борта на карте.
          </p>
          {loading ? (
            <Skeleton rows={4} />
          ) : orders.length === 0 ? (
            <Empty title="Рейсов пока нет" hint="Возьмите заказ на бирже, затем назначьте борт." />
          ) : (
            <div className="card-list">
              {orders.map((o) => {
                const canAssign = (o.status === "taken" || o.status === "assigned") && !o.vehicle_id;
                const boards = idleBoards.filter((v) => v.capacity_kg >= o.weight_kg);
                return (
                  <div
                    key={o.id}
                    className={`card${selected?.id === o.id ? " selected" : ""}`}
                    onMouseEnter={() => showTrip(o)}
                    onClick={() => showTrip(o)}
                    style={{ cursor: "pointer" }}
                  >
                    <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                    {o.is_backhaul && <span className="badge back">обратка</span>}
                    <h3>
                      {o.origin_name} → {o.dest_name}
                    </h3>
                    <div className="meta">
                      <span>{o.cargo_title}</span>
                      <span>{o.weight_kg} кг</span>
                      <span>{o.distance_km} км</span>
                      <span>{o.plate ?? "нужен борт"}</span>
                    </div>
                    {canAssign ? (
                      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={assign[o.id] ?? 0}
                          onChange={(e) => setAssign({ ...assign, [o.id]: Number(e.target.value) })}
                        >
                          <option value={0}>Борт</option>
                          {boards.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.plate} · {v.driver_name}
                            </option>
                          ))}
                        </select>
                        <button type="button" className="btn small" disabled={!assign[o.id]} onClick={() => onAssign(o)}>
                          Назначить
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function OrdersTable({
  orders,
  hintMap,
  idleBoards,
  assign,
  setAssign,
  showTake,
  showAssign,
  onTake,
  onAssign,
}: {
  orders: Order[];
  hintMap: Record<number, MatchHint>;
  idleBoards: Vehicle[];
  assign: Record<number, number>;
  setAssign: (v: Record<number, number>) => void;
  showTake?: boolean;
  showAssign?: boolean;
  onTake?: (o: Order) => void;
  onAssign?: (o: Order) => void;
}) {
  if (orders.length === 0) {
    return <Empty title="Нет заявок" hint={showTake ? "Пока биржа пуста." : "Возьмите заказ на бирже."} />;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Маршрут</th>
          <th>Груз</th>
          <th>Статус</th>
          <th>₸</th>
          {(showTake || showAssign) && <th></th>}
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const h = hintMap[o.id];
          const canAssign = showAssign && (o.status === "taken" || o.status === "assigned") && !o.vehicle_id;
          const boards = idleBoards.filter((v) => v.capacity_kg >= o.weight_kg);
          return (
            <tr key={o.id}>
              <td>{o.id}</td>
              <td>
                {o.origin_name} → {o.dest_name}
                {h ? (
                  <>
                    <br />
                    <span className="badge back">попутка · −{h.empty_km_saved} км</span>
                  </>
                ) : null}
              </td>
              <td>
                {o.cargo_title}
                <br />
                <span className="lede" style={{ margin: 0 }}>
                  {o.weight_kg} кг · {o.distance_km} км
                  {o.plate ? ` · ${o.plate}` : ""}
                </span>
              </td>
              <td>
                <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
              </td>
              <td>{o.price_offered.toLocaleString("ru-KZ")}</td>
              {(showTake || showAssign) && (
                <td>
                  <div className="row-actions" style={{ marginTop: 0 }}>
                    {showTake ? (
                      <button type="button" className="btn small" onClick={() => onTake?.(o)}>
                        Взять
                      </button>
                    ) : null}
                    {canAssign ? (
                      <>
                        <select
                          value={assign[o.id] ?? 0}
                          onChange={(e) => setAssign({ ...assign, [o.id]: Number(e.target.value) })}
                        >
                          <option value={0}>Борт</option>
                          {boards.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.plate} · {v.driver_name}
                            </option>
                          ))}
                        </select>
                        <button type="button" className="btn small" disabled={!assign[o.id]} onClick={() => onAssign?.(o)}>
                          Назначить
                        </button>
                      </>
                    ) : null}
                  </div>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
