import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Empty, { Skeleton } from "../components/Empty";
import MapView from "../components/MapView";
import { BarList, ChartCard, DonutChart, MetricCard, SparkBars, ordersByDay, statusSlices } from "../components/Charts";
import { useToast } from "../components/Toast";
import ProfileForm from "../components/ProfileForm";
import { api, errText, getStoredUser, streamUrl } from "../api";
import { formatKg } from "../lib/fleet";
import { deltaLabel, fmtNum, orderCode } from "../lib/format";
import { STATUS_RU, VEHICLE_STATUS_RU } from "../lib/labels";
import type { Analytics, Order, Settlement, User, Vehicle } from "../types";

type Tab = "overview" | "analytics" | "users" | "profile";
type SuperInfo = "senders" | "carriers" | "drivers" | "vehicles" | "live" | "open" | "transit";
type UserFilter = "all" | "sender" | "carrier";
type StatusFilter = "all" | "active" | "blocked";
type ConfirmKind = "block" | "unblock" | "password";

const ROLE_LABELS: Record<string, string> = {
  sender: "Отправитель",
  carrier: "Перевозчик",
  driver: "Водитель",
  admin: "Админ",
  superadmin: "Супер-админ",
  dispatcher: "Админ",
};

const MANAGED_ROLES = new Set(["sender", "carrier"]);
const ADMIN_ROLES = new Set(["admin", "dispatcher"]);
const USER_PAGE = 20;

function recentOrders(orders: Order[], limit = 8) {
  return [...orders]
    .sort((a, b) => {
      const ta = a.created_at ?? "";
      const tb = b.created_at ?? "";
      if (ta !== tb) return tb.localeCompare(ta);
      return b.id - a.id;
    })
    .slice(0, limit);
}

export default function Dispatcher({ user, onUser }: { user: User; onUser: (user: User) => void }) {
  const toast = useToast();
  const isSuper = user.role === "superadmin";
  const tabs = isSuper
    ? ([
        { id: "overview", label: "Дашборд" },
        { id: "analytics", label: "Аналитика" },
        { id: "users", label: "Админы" },
      ] as { id: Tab; label: string }[])
    : ([
        { id: "overview", label: "Обзор" },
        { id: "analytics", label: "Аналитика" },
        { id: "users", label: "Пользователи" },
        { id: "profile", label: "Профиль" },
      ] as { id: Tab; label: string }[]);
  const [tab, setTab] = useState<Tab>("overview");
  const [info, setInfo] = useState<SuperInfo | null>(null);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [stats, setStats] = useState<Analytics | null>(null);
  const [routes, setRoutes] = useState<{ id: string; coords: number[][] }[]>([]);
  const [booting, setBooting] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoadError(null);
      const base = Promise.all([
        api<Settlement[]>("/api/geo/settlements"),
        api<Order[]>("/api/orders"),
        api<User[]>("/api/admin/users"),
        api<Analytics>("/api/analytics/summary"),
      ]);
      if (isSuper) {
        const [[s, o, u, a], v] = await Promise.all([base, api<Vehicle[]>("/api/geo/vehicles")]);
        setSettlements(s);
        setOrders(o);
        setUsers(u);
        setStats(a);
        setVehicles(v);
        const active = o.filter((x) => x.status === "transit");
        const lines = await Promise.all(
          active.map(async (item) => {
            try {
              const r = await api<{ geometry: number[][] }>(`/api/orders/${item.id}/route`);
              return { id: String(item.id), coords: r.geometry };
            } catch {
              return { id: String(item.id), coords: [] as number[][] };
            }
          })
        );
        setRoutes(lines.filter((line) => line.coords.length > 1));
      } else {
        const [s, o, u, a] = await base;
        setSettlements(s);
        setOrders(o);
        setUsers(u);
        setStats(a);
        setVehicles([]);
        setRoutes([]);
      }
    } catch (ex) {
      const text = errText(ex);
      setLoadError(text);
      toast.err(text);
    } finally {
      setBooting(false);
    }
  }, [isSuper, toast]);

  useEffect(() => {
    reload();
    const tick = setInterval(() => {
      api<Analytics>("/api/analytics/summary")
        .then(setStats)
        .catch(() => undefined);
      if (!isSuper) {
        api<Order[]>("/api/orders")
          .then(setOrders)
          .catch(() => undefined);
      }
    }, 10000);

    if (!isSuper) {
      return () => clearInterval(tick);
    }

    const es = new EventSource(streamUrl("/api/tracking/stream"));
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { type?: string; vehicles?: Vehicle[] };
        if (data.type === "fleet" && data.vehicles) setVehicles(data.vehicles);
        if (data.type === "order") reload();
      } catch {
        /* keep last snapshot */
      }
    };

    return () => {
      es.close();
      clearInterval(tick);
    };
  }, [isSuper, reload]);

  const mapMode = tab === "overview" && !info;

  return (
    <div className={`cabinet${isSuper ? " super-cabinet" : " admin-cabinet"}${mapMode ? " map-mode" : ""}`}>
      <div className="cabinet-head">
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
        <p className="kicker cabinet-role">{isSuper ? "Супер-администратор" : "Администратор"}</p>
      </div>
      {loadError && !stats && settlements.length === 0 ? (
        <div className={isSuper ? "super-body" : ""}>
          <Empty title="Не удалось загрузить кабинет" hint={loadError} />
          <div className="row-actions">
            <button type="button" className="btn" onClick={reload}>
              Повторить
            </button>
          </div>
        </div>
      ) : (
        <>
          {tab === "overview" && info && (
            <div className="super-body">
              <SuperInfo kind={info} users={users} vehicles={vehicles} orders={orders} onBack={() => setInfo(null)} />
            </div>
          )}
          {tab === "overview" && !info && (
            <Overview
              stats={stats}
              settlements={settlements}
              vehicles={vehicles}
              routes={routes}
              orders={orders}
              users={users}
              systemWide={isSuper}
              loading={booting}
              onOpenAdmins={() => setTab("users")}
              onOpenInfo={setInfo}
            />
          )}
          {tab === "analytics" &&
            (isSuper ? (
              <div className="super-body">
                <AnalyticsPage
                  stats={stats}
                  orders={orders}
                  vehicles={vehicles}
                  systemWide
                  loading={booting}
                />
              </div>
            ) : (
              <AnalyticsPage
                stats={stats}
                orders={orders}
                vehicles={[]}
                systemWide={false}
                loading={booting}
              />
            ))}
          {tab === "users" &&
            (isSuper ? (
              <div className="super-body">
                <UsersTab users={users} reload={reload} adminsOnly />
              </div>
            ) : (
              <UsersTab users={users} reload={reload} adminsOnly={false} />
            ))}
          {tab === "profile" && !isSuper && <ProfileForm user={user} onUser={onUser} />}
        </>
      )}
    </div>
  );
}

function Overview({
  stats,
  settlements,
  vehicles,
  routes,
  orders,
  users,
  systemWide,
  loading,
  onOpenAdmins,
  onOpenInfo,
}: {
  stats: Analytics | null;
  settlements: Settlement[];
  vehicles: Vehicle[];
  routes: { id: string; coords: number[][] }[];
  orders: Order[];
  users: User[];
  systemWide: boolean;
  loading: boolean;
  onOpenAdmins?: () => void;
  onOpenInfo?: (kind: SuperInfo) => void;
}) {
  const byRole = (role: string) => users.filter((u) => u.role === role).length;
  const live = vehicles.filter((v) => v.live).length;
  const [panelOpen, setPanelOpen] = useState(true);
  const [barDocked, setBarDocked] = useState(false);

  if (systemWide) {
    const feed = recentOrders(orders);
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
          <div className="super-hud monitor-hud">
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
                <h3>Система</h3>
                <div className="stats fit">
                  <button type="button" className="stat stat-link" onClick={onOpenAdmins}>
                    <b>{byRole("admin") + byRole("dispatcher")}</b>
                    <span>админов</span>
                  </button>
                  <button type="button" className="stat stat-link" onClick={() => onOpenInfo?.("senders")}>
                    <b>{byRole("sender")}</b>
                    <span>отправителей</span>
                  </button>
                  <button type="button" className="stat stat-link" onClick={() => onOpenInfo?.("carriers")}>
                    <b>{byRole("carrier")}</b>
                    <span>перевозчиков</span>
                  </button>
                  <button type="button" className="stat stat-link" onClick={() => onOpenInfo?.("drivers")}>
                    <b>{byRole("driver")}</b>
                    <span>водителей</span>
                  </button>
                  <button type="button" className="stat stat-link" onClick={() => onOpenInfo?.("vehicles")}>
                    <b>{vehicles.length}</b>
                    <span>машин</span>
                  </button>
                  <button type="button" className="stat stat-link" onClick={() => onOpenInfo?.("live")}>
                    <b>{live}</b>
                    <span>live GPS</span>
                  </button>
                  <button type="button" className="stat stat-link" onClick={() => onOpenInfo?.("open")}>
                    <b>{orders.filter((o) => o.status === "open").length}</b>
                    <span>открытых</span>
                  </button>
                  <button type="button" className="stat stat-link" onClick={() => onOpenInfo?.("transit")}>
                    <b>{orders.filter((o) => o.status === "transit").length}</b>
                    <span>в рейсе</span>
                  </button>
                </div>
              </div>
              <div className="super-bar-block">
                <h3>Экономика</h3>
                {!stats ? (
                  <Skeleton rows={2} />
                ) : (
                  <div className="eco-lines">
                    <div>
                      <span>Порожняк</span>
                      <b>{fmtNum(stats.empty_km_with_platform)} км</b>
                    </div>
                    {stats.empty_km_without_platform != null && (
                      <div>
                        <span>Без платформы</span>
                        <b>{fmtNum(stats.empty_km_without_platform)} км</b>
                      </div>
                    )}
                    <div>
                      <span>Топливо</span>
                      <b>{fmtNum(stats.fuel_saved_l)} л</b>
                    </div>
                    <div>
                      <span>Стоимость</span>
                      <b>{fmtNum(stats.money_saved_kzt)} ₸</b>
                    </div>
                    {stats.empty_km_saved > 0 && (
                      <div>
                        <span>Сэкономлено</span>
                        <b>{fmtNum(stats.empty_km_saved)} км</b>
                      </div>
                    )}
                    {stats.empty_share_history != null && (
                      <div>
                        <span>Доля порожняка</span>
                        <b>{fmtNum(stats.empty_share_history * 100, 1)}%</b>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </aside>
            <aside className="super-side">
              <h3>Последние заявки</h3>
              {loading && feed.length === 0 ? (
                <Skeleton rows={3} />
              ) : feed.length === 0 ? (
                <Empty title="Нет заявок" />
              ) : (
                <div className="feed-list">
                  {feed.map((o) => (
                    <button
                      type="button"
                      className="feed-item"
                      key={o.id}
                      onClick={() => {
                        if (o.status === "open") onOpenInfo?.("open");
                        else if (o.status === "transit") onOpenInfo?.("transit");
                      }}
                    >
                      <span className="job-status">
                        <i className={`status-dot ${o.status}`} />
                        {STATUS_RU[o.status] ?? o.status}
                      </span>
                      <strong>
                        {o.origin_name} → {o.dest_name}
                      </strong>
                    </button>
                  ))}
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    );
  }

  return <AdminOverview stats={stats} settlements={settlements} orders={orders} loading={loading} />;
}

function AdminOverview({
  stats,
  settlements,
  orders,
  loading,
}: {
  stats: Analytics | null;
  settlements: Settlement[];
  orders: Order[];
  loading: boolean;
}) {
  const [panelOpen, setPanelOpen] = useState(true);
  const corridors = stats?.corridors ?? [];
  const openJobs = orders.filter((o) => o.status === "open");
  const transitJobs = orders.filter((o) => o.status === "transit");
  const fitTo = settlements.map((s) => [s.lon, s.lat]);

  return (
    <div className="admin-overview">
      {settlements.length === 0 && !loading ? (
        <div className="admin-map-empty">
          <Empty title="Нет геоданных" hint="Справочник пунктов пока пуст." />
        </div>
      ) : (
        <MapView
          settlements={settlements}
          vehicles={[]}
          routes={[]}
          legend="places"
          fitTo={fitTo}
          fitMaxZoom={8.4}
          navPosition="bottom-right"
        />
      )}
      <button
        type="button"
        className={`btn small super-panel-toggle${panelOpen ? " on-panel" : ""}`}
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={panelOpen}
      >
        {panelOpen ? "Скрыть панели" : "Показатели"}
      </button>
      {panelOpen && (
        <div className="super-hud admin-hud">
          <aside className="super-bar admin-dash">
            <header className="admin-hero">
              <h2 className="display">Грузопотоки внутри области</h2>
              <p className="lede">Активность перевозок и движение грузов внутри Мангистауской области.</p>
            </header>
            {!stats && loading ? (
              <Skeleton rows={4} />
            ) : !stats ? (
              <Empty title="Нет данных аналитики" hint="Показатели появятся после первых завершённых рейсов." />
            ) : (
              <div className="metric-grid">
                <MetricCard
                  name="Км с грузом"
                  value={fmtNum(stats.loaded_km)}
                  unit="км"
                  delta={deltaLabel(stats.loaded_km_delta)}
                />
                <MetricCard
                  name="Порожняк"
                  value={fmtNum(stats.empty_km_with_platform)}
                  unit="км"
                  delta={deltaLabel(stats.empty_km_delta)}
                />
                <MetricCard
                  name="Дизель"
                  value={fmtNum(stats.fuel_saved_l)}
                  unit="л"
                  delta={deltaLabel(stats.fuel_saved_delta)}
                />
                <MetricCard
                  name="Топливо"
                  value={fmtNum(stats.money_saved_kzt)}
                  unit="₸"
                  delta={deltaLabel(stats.money_saved_delta)}
                />
              </div>
            )}
            <section className="admin-panel">
              <h3>Коридоры</h3>
              {loading && corridors.length === 0 ? (
                <Skeleton rows={4} />
              ) : corridors.length === 0 ? (
                <Empty title="Нет коридоров" hint="Маршруты появятся по активным и завершённым рейсам." />
              ) : (
                <>
                  <div className="table-scroll">
                    <table className="data-table compact-table">
                      <thead>
                        <tr>
                          <th>Маршрут</th>
                          <th className="num">Рейсы</th>
                          <th className="num">Км</th>
                        </tr>
                      </thead>
                      <tbody>
                        {corridors.map((c) => (
                          <tr key={c.from + c.to}>
                            <td className="route-name">
                              {c.from} → {c.to}
                            </td>
                            <td className="num">{c.trips}</td>
                            <td className="num">{fmtNum(c.km)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </aside>
          <aside className="super-side admin-jobs">
            <section className="admin-panel">
              <h3>Открытые заявки</h3>
              {loading && openJobs.length === 0 ? (
                <Skeleton rows={3} />
              ) : openJobs.length === 0 ? (
                <Empty title="Нет открытых заявок" />
              ) : (
                <>
                  <div className="job-stack">
                    {openJobs.map((o) => (
                      <OpenJobCard key={o.id} order={o} />
                    ))}
                  </div>
                </>
              )}
            </section>
            <section className="admin-panel">
              <h3>В рейсе</h3>
              {loading && transitJobs.length === 0 ? (
                <Skeleton rows={2} />
              ) : transitJobs.length === 0 ? (
                <Empty title="Нет рейсов в пути" />
              ) : (
                <>
                  <div className="job-stack">
                    {transitJobs.map((o) => (
                      <TransitJobCard key={o.id} order={o} />
                    ))}
                  </div>
                </>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}


function AnalyticsPage({
  stats,
  orders,
  vehicles,
  systemWide,
  loading,
}: {
  stats: Analytics | null;
  orders: Order[];
  vehicles: Vehicle[];
  systemWide: boolean;
  loading: boolean;
}) {
  const [allCorridors, setAllCorridors] = useState(false);
  const corridors = stats?.corridors ?? [];
  const shownCorridors = allCorridors ? corridors : corridors.slice(0, 8);
  const backhaul = orders.filter((o) => o.is_backhaul).length;
  const direct = orders.length - backhaul;
  const live = vehicles.filter((v) => v.live).length;
  const without = stats?.empty_km_without_platform;
  const share = stats?.empty_share_history;
  const assumptions = stats?.assumptions;
  const slices = useMemo(() => statusSlices(orders), [orders]);
  const days = useMemo(() => ordersByDay(orders), [orders]);
  const corridorBars = corridors.map((c) => ({
    label: `${c.from} → ${c.to}`,
    value: c.km,
    tone: "sea" as const,
  }));
  const kmBars = stats
    ? [
        { label: "С грузом", value: stats.loaded_km, tone: "sea" },
        { label: "Порожняк", value: stats.empty_km_with_platform, tone: "dust" },
        ...(systemWide && without != null ? [{ label: "Без платформы", value: without, tone: "coral" }] : []),
      ]
    : [];
  const mixBars =
    orders.length > 0
      ? [
          { label: "Прямые", value: direct, tone: "sea" },
          { label: "Обратки", value: backhaul, tone: "coral" },
        ]
      : [];
  const fleetBars = systemWide
    ? [
        { label: "Live GPS", value: live, tone: "sea" },
        { label: "Без GPS", value: Math.max(vehicles.length - live, 0), tone: "muted" },
      ]
    : [];

  return (
    <div className="analytics-page">
      <header className="admin-hero">
        <h2 className="display">Аналитика</h2>
        <p className="lede">
          {systemWide
            ? "Перевозки, экономия топлива и сравнение с базой без платформы."
            : "Активность перевозок и движение грузов внутри Мангистауской области."}
        </p>
      </header>

      {!stats && loading ? (
        <Skeleton rows={4} />
      ) : !stats ? (
        <Empty title="Нет данных аналитики" hint="Показатели появятся после первых завершённых рейсов." />
      ) : (
        <>
          <section>
            <h3 className="analytics-kicker">Грузопотоки</h3>
            <div className="metric-grid">
              <MetricCard
                name="Км с грузом"
                value={fmtNum(stats.loaded_km)}
                unit="км"
                delta={deltaLabel(stats.loaded_km_delta)}
              />
              <MetricCard
                name="Порожняк"
                value={fmtNum(stats.empty_km_with_platform)}
                unit="км"
                delta={deltaLabel(stats.empty_km_delta)}
              />
              <MetricCard
                name="Дизель"
                value={fmtNum(stats.fuel_saved_l)}
                unit="л"
                delta={deltaLabel(stats.fuel_saved_delta)}
              />
              <MetricCard
                name="Топливо"
                value={fmtNum(stats.money_saved_kzt)}
                unit="₸"
                delta={deltaLabel(stats.money_saved_delta)}
              />
            </div>
          </section>

          <section>
            <h3 className="analytics-kicker">Сейчас</h3>
            <div className="metric-grid analytics-now">
              <MetricCard name="Открытые" value={fmtNum(stats.open_orders)} unit="заявок" />
              <MetricCard name="В рейсе" value={fmtNum(stats.in_transit)} unit="рейсов" />
              <MetricCard name="Доставлено" value={fmtNum(stats.delivered)} unit="рейсов" />
              <MetricCard name="Обратки" value={fmtNum(backhaul)} unit="заявок" />
            </div>
          </section>

          {systemWide && (
            <section>
              <h3 className="analytics-kicker">Экономика</h3>
              <div className="metric-grid">
                {without != null && <MetricCard name="Без платформы" value={fmtNum(without)} unit="км" />}
                <MetricCard name="Сэкономлено" value={fmtNum(stats.empty_km_saved)} unit="км" />
                {share != null && <MetricCard name="Доля порожняка" value={fmtNum(share * 100, 1)} unit="%" />}
                <MetricCard name="Автопарк" value={fmtNum(stats.vehicles)} unit="машин" />
                <MetricCard name="Live GPS" value={fmtNum(live)} unit="бортов" />
                <MetricCard name="Пункты" value={fmtNum(stats.settlements)} unit="точек" />
              </div>
              {(assumptions?.diesel_l_per_100km != null || assumptions?.diesel_kzt_per_l != null) && (
                <p className="lede analytics-note">
                  Расчёт:
                  {assumptions.diesel_l_per_100km != null ? ` ${assumptions.diesel_l_per_100km} л / 100 км` : ""}
                  {assumptions.diesel_kzt_per_l != null ? ` · ${fmtNum(assumptions.diesel_kzt_per_l)} ₸ / л` : ""}
                  {assumptions.empty_share_without != null
                    ? ` · база порожняка ${fmtNum(assumptions.empty_share_without * 100)}%`
                    : ""}
                  .
                </p>
              )}
            </section>
          )}

          <div className="chart-grid">
            <ChartCard title="Коридоры, км">
              <BarList items={corridorBars} unit="км" />
            </ChartCard>
            <ChartCard title="Статусы заявок">
              <DonutChart slices={slices} />
            </ChartCard>
            <ChartCard title="Километраж">
              <BarList items={kmBars} unit="км" />
            </ChartCard>
            <ChartCard title="Прямые и обратки">
              {mixBars.some((i) => i.value > 0) ? <BarList items={mixBars} unit="" /> : <Empty title="Нет заявок" />}
            </ChartCard>
            {days.length > 0 && (
              <ChartCard title="Заявки за 14 дней">
                <SparkBars points={days} />
              </ChartCard>
            )}
            {systemWide && vehicles.length > 0 && (
              <ChartCard title="Геолокация парка">
                <BarList items={fleetBars} />
              </ChartCard>
            )}
          </div>

          <section className="admin-panel">
            <h3>Коридоры</h3>
            {corridors.length === 0 ? (
              <Empty title="Нет коридоров" hint="Маршруты появятся по активным и завершённым рейсам." />
            ) : (
              <>
                <div className="table-scroll">
                  <table className="data-table compact-table">
                    <thead>
                      <tr>
                        <th>Маршрут</th>
                        <th className="num">Рейсы</th>
                        <th className="num">Км</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownCorridors.map((c) => (
                        <tr key={c.from + c.to}>
                          <td className="route-name">
                            {c.from} → {c.to}
                          </td>
                          <td className="num">{c.trips}</td>
                          <td className="num">{fmtNum(c.km)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {corridors.length > 8 && (
                  <button type="button" className="btn secondary small text-btn" onClick={() => setAllCorridors((v) => !v)}>
                    {allCorridors ? "Свернуть" : "Показать все"}
                  </button>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function OpenJobCard({ order }: { order: Order }) {
  return (
    <article className="job-card">
      <header className="job-card-head">
        <span className="job-status">
          <i className={`status-dot ${order.status}`} />
          {(STATUS_RU[order.status] ?? order.status).toUpperCase()}
        </span>
        <span className="job-id">{orderCode(order.id)}</span>
      </header>
      {order.is_backhaul && <div className="job-back">↔ Обратка</div>}
      <h4>
        {order.origin_name} → {order.dest_name}
      </h4>
      <p>{order.cargo_title}</p>
      <p className="meta">{formatKg(order.weight_kg)}</p>
      <p className="meta">{order.plate ?? "Ждёт машину"}</p>
    </article>
  );
}

function TransitJobCard({ order }: { order: Order }) {
  return (
    <article className="job-card">
      <header className="job-card-head">
        <span className="job-status">
          <i className="status-dot transit" />
          В рейсе
        </span>
        <span className="job-id">{orderCode(order.id)}</span>
      </header>
      <h4>
        {order.origin_name} → {order.dest_name}
      </h4>
      <p>{order.cargo_title}</p>
    </article>
  );
}

const INFO_TITLE: Record<SuperInfo, string> = {
  senders: "Отправители",
  carriers: "Перевозчики",
  drivers: "Водители",
  vehicles: "Автопарк",
  live: "Live GPS",
  open: "Открытые заявки",
  transit: "Заявки в рейсе",
};

const INFO_EMPTY: Record<SuperInfo, string> = {
  senders: "Нет отправителей",
  carriers: "Нет перевозчиков",
  drivers: "Нет водителей",
  vehicles: "Нет машин",
  live: "Нет машин с активной геолокацией",
  open: "Нет открытых заявок",
  transit: "Нет рейсов в пути",
};

function SuperInfo({
  kind,
  users,
  vehicles,
  orders,
  onBack,
}: {
  kind: SuperInfo;
  users: User[];
  vehicles: Vehicle[];
  orders: Order[];
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(USER_PAGE);
  const q = query.trim().toLowerCase();

  const people =
    kind === "senders"
      ? users.filter((u) => u.role === "sender")
      : kind === "carriers"
        ? users.filter((u) => u.role === "carrier")
        : kind === "drivers"
          ? users.filter((u) => u.role === "driver")
          : null;
  const fleet = kind === "vehicles" ? vehicles : kind === "live" ? vehicles.filter((v) => v.live) : null;
  const jobs = kind === "open" ? orders.filter((o) => o.status === "open") : kind === "transit" ? orders.filter((o) => o.status === "transit") : null;

  const peopleRows = (people ?? []).filter((u) => {
    if (!q) return true;
    return `${u.name} ${u.email} ${u.company ?? ""} ${u.phone ?? ""}`.toLowerCase().includes(q);
  });
  const fleetRows = (fleet ?? []).filter((v) => {
    if (!q) return true;
    return `${v.plate} ${v.driver_name} ${v.status}`.toLowerCase().includes(q);
  });
  const jobRows = (jobs ?? []).filter((o) => {
    if (!q) return true;
    return `${o.origin_name} ${o.dest_name} ${o.cargo_title} ${orderCode(o.id)}`.toLowerCase().includes(q);
  });
  const total = people ? peopleRows.length : fleet ? fleetRows.length : jobRows.length;
  const shownPeople = peopleRows.slice(0, visible);
  const shownFleet = fleetRows.slice(0, visible);
  const shownJobs = jobRows.slice(0, visible);

  useEffect(() => {
    setVisible(USER_PAGE);
  }, [kind, query]);

  return (
    <div>
      <div className="row-actions" style={{ marginBottom: 14 }}>
        <button type="button" className="btn secondary small" onClick={onBack}>
          ← К карте
        </button>
      </div>
      <h2 className="display cabinet-title" style={{ display: "block", fontSize: 28, marginBottom: 8 }}>
        {INFO_TITLE[kind]}
      </h2>
      <p className="lede" style={{ marginBottom: 14 }}>
        {total} {total === 1 ? "запись" : "записей"}
      </p>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск..."
        aria-label="Поиск"
        style={{ marginBottom: 14, maxWidth: 360 }}
      />
      {people &&
        (peopleRows.length === 0 ? (
          <Empty title={INFO_EMPTY[kind]} hint={q ? "Попробуйте изменить запрос." : undefined} />
        ) : (
          <>
            <PeopleTable rows={shownPeople} />
            {peopleRows.length > visible && (
              <button type="button" className="btn secondary small text-btn" onClick={() => setVisible((n) => n + USER_PAGE)}>
                Показать ещё
              </button>
            )}
          </>
        ))}
      {fleet &&
        (fleetRows.length === 0 ? (
          <Empty title={INFO_EMPTY[kind]} hint={q ? "Попробуйте изменить запрос." : undefined} />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table compact-table">
                <thead>
                  <tr>
                    <th>Госномер</th>
                    <th>Водитель</th>
                    <th>Статус</th>
                    <th>GPS</th>
                  </tr>
                </thead>
                <tbody>
                  {shownFleet.map((v) => (
                    <tr key={v.id}>
                      <td className="route-name">{v.plate}</td>
                      <td>{v.driver_name}</td>
                      <td>
                        <span className="badge">{VEHICLE_STATUS_RU[v.status] ?? v.status}</span>
                      </td>
                      <td>{v.live ? "live" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {fleetRows.length > visible && (
              <button type="button" className="btn secondary small text-btn" onClick={() => setVisible((n) => n + USER_PAGE)}>
                Показать ещё
              </button>
            )}
          </>
        ))}
      {jobs &&
        (jobRows.length === 0 ? (
          <Empty title={INFO_EMPTY[kind]} hint={q ? "Попробуйте изменить запрос." : undefined} />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table compact-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Маршрут</th>
                    <th>Груз</th>
                    <th>Статус</th>
                    <th className="num">₸</th>
                  </tr>
                </thead>
                <tbody>
                  {shownJobs.map((o) => (
                    <tr key={o.id}>
                      <td>{orderCode(o.id)}</td>
                      <td className="route-name">
                        {o.origin_name} → {o.dest_name}
                      </td>
                      <td>{o.cargo_title}</td>
                      <td>
                        <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                      </td>
                      <td className="num">{o.price_offered.toLocaleString("ru-KZ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {jobRows.length > visible && (
              <button type="button" className="btn secondary small text-btn" onClick={() => setVisible((n) => n + USER_PAGE)}>
                Показать ещё
              </button>
            )}
          </>
        ))}
    </div>
  );
}

function PeopleTable({ rows }: { rows: User[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table compact-table users-table">
        <thead>
          <tr>
            <th>Пользователь</th>
            <th>Контакты</th>
            <th>Роль</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => {
            const blocked = u.is_active === false;
            return (
              <tr key={u.id}>
                <td>
                  <div className="user-cell">
                    <strong>{u.name}</strong>
                    <span>{u.company ?? "—"}</span>
                  </div>
                </td>
                <td>
                  <div className="user-cell">
                    <span>{u.email}</span>
                    <span>{u.phone ?? "—"}</span>
                  </div>
                </td>
                <td>
                  <span className="badge">{ROLE_LABELS[u.role] ?? u.role}</span>
                </td>
                <td>
                  <span className={`user-status ${blocked ? "off" : "on"}`}>
                    <i />
                    {blocked ? "Заблокирован" : "Активен"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UsersTab({
  users,
  reload,
  adminsOnly,
}: {
  users: User[];
  reload: () => Promise<void>;
  adminsOnly: boolean;
}) {
  const toast = useToast();
  const me = getStoredUser();
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
  const [form, setForm] = useState({ email: "", name: "", role: "sender", company: "", phone: "", password: "" });
  const [filter, setFilter] = useState<UserFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(USER_PAGE);
  const [createOpen, setCreateOpen] = useState(false);
  const [menuId, setMenuId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; user: User } | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const roleOptions = useMemo(
    () => options.filter((r) => MANAGED_ROLES.has(r.id)),
    [options]
  );

  const filtered = useMemo(() => {
    const base = users.filter((u) => u.id !== me?.id);
    const scoped = adminsOnly
      ? base.filter((u) => ADMIN_ROLES.has(u.role))
      : base.filter((u) => MANAGED_ROLES.has(u.role));
    const byRole = adminsOnly || filter === "all" ? scoped : scoped.filter((u) => u.role === filter);
    const byStatus =
      status === "all" ? byRole : byRole.filter((u) => (u.is_active === false) === (status === "blocked"));
    const q = query.trim().toLowerCase();
    const found = q
      ? byStatus.filter((u) =>
          `${u.name} ${u.email} ${u.company ?? ""} ${u.phone ?? ""} ${ROLE_LABELS[u.role] ?? ""}`.toLowerCase().includes(q)
        )
      : byStatus;
    return [...found].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [adminsOnly, filter, me?.id, query, status, users]);

  const shown = filtered.slice(0, visible);

  useEffect(() => {
    setVisible(USER_PAGE);
    setMenuId(null);
  }, [filter, status, query, adminsOnly]);

  useEffect(() => {
    if (menuId == null) return;
    function onDoc(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuId(null);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuId]);

  useEffect(() => {
    if (adminsOnly) return;
    api<{ id: string; label: string }[]>("/api/admin/role-options")
      .then((rows) => {
        const allowed = rows.filter((r) => MANAGED_ROLES.has(r.id));
        setOptions(allowed);
        setForm((f) => ({ ...f, role: f.role || allowed[0]?.id || "sender" }));
      })
      .catch((ex) => toast.err(errText(ex)));
  }, [adminsOnly, toast]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const role = adminsOnly ? "admin" : form.role;
    if (!adminsOnly && !MANAGED_ROLES.has(role)) {
      toast.err("Можно создать только отправителя или перевозчика");
      return;
    }
    setCreating(true);
    try {
      const created = await api<User>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ ...form, role }),
      });
      toast.ok(
        created.initial_password
          ? `Пользователь ${form.email} создан · пароль ${created.initial_password}`
          : `Пользователь ${form.email} создан`,
        created.initial_password ? 12000 : undefined
      );
      setForm({ email: "", name: "", role: roleOptions[0]?.id || "sender", company: "", phone: "", password: "" });
      setCreateOpen(false);
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    } finally {
      setCreating(false);
    }
  }

  async function applyConfirm() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "password") {
        const row = await api<User>(`/api/admin/users/${confirm.user.id}/reset-password`, {
          method: "POST",
          body: "{}",
        });
        toast.ok(
          row.initial_password ? `Новый пароль: ${row.initial_password}` : "Пароль сброшен",
          row.initial_password ? 12000 : undefined
        );
      } else {
        await api(`/api/admin/users/${confirm.user.id}/${confirm.kind}`, {
          method: "POST",
          body: "{}",
        });
        toast.ok(confirm.kind === "block" ? "Пользователь заблокирован" : "Пользователь разблокирован");
      }
      setConfirm(null);
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    } finally {
      setBusy(false);
    }
  }

  const confirmCopy =
    confirm?.kind === "password"
      ? { title: "Сброс пароля", text: "Сбросить пароль пользователя?", action: "Сбросить" }
      : confirm?.kind === "block"
        ? { title: "Блокировка", text: "Заблокировать пользователя?", action: "Заблокировать" }
        : { title: "Разблокировка", text: "Разблокировать пользователя?", action: "Разблокировать" };

  return (
    <div className="users-page">
      <div className="users-toolbar">
        <div className="users-toolbar-head">
          <div>
            <h2 className="display cabinet-title" style={{ display: "block", fontSize: 28, margin: 0 }}>
              {adminsOnly ? "Администраторы" : "Пользователи"}
            </h2>
            <p className="lede" style={{ margin: "6px 0 0" }}>
              {filtered.length} в списке
            </p>
          </div>
          <button type="button" className="btn small" onClick={() => setCreateOpen(true)}>
            {adminsOnly ? "Новый администратор" : "Новый пользователь"}
          </button>
        </div>
        <div className="users-toolbar-row">
          {!adminsOnly && (
            <div className="tabs">
              {(
                [
                  ["all", "Все"],
                  ["sender", "Отправители"],
                  ["carrier", "Перевозчики"],
                ] as [UserFilter, string][]
              ).map(([id, label]) => (
                <button key={id} type="button" className={`tab${filter === id ? " active" : ""}`} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="tabs">
            {(
              [
                ["all", "Все статусы"],
                ["active", "Активные"],
                ["blocked", "Заблокированные"],
              ] as [StatusFilter, string][]
            ).map(([id, label]) => (
              <button key={id} type="button" className={`tab${status === id ? " active" : ""}`} onClick={() => setStatus(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск пользователя..."
          aria-label="Поиск пользователя"
        />
      </div>
      {shown.length === 0 ? (
        <Empty
          title={adminsOnly ? "Пока нет администраторов" : "Пока нет пользователей"}
          hint={query || status !== "all" || filter !== "all" ? "Попробуйте изменить запрос или фильтр." : undefined}
        />
      ) : (
        <>
          <div className="table-scroll">
            <table className="data-table compact-table users-table">
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Контакты</th>
                  <th>Роль</th>
                  <th>Статус</th>
                  {!adminsOnly ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => {
                  const blocked = u.is_active === false;
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="user-cell">
                          <strong>{u.name}</strong>
                          <span>{u.company ?? "—"}</span>
                        </div>
                      </td>
                      <td>
                        <div className="user-cell">
                          <span>{u.email}</span>
                          <span>{u.phone ?? "—"}</span>
                        </div>
                      </td>
                      <td>
                        <span className="badge">{ROLE_LABELS[u.role] ?? u.role}</span>
                      </td>
                      <td>
                        <span className={`user-status ${blocked ? "off" : "on"}`}>
                          <i />
                          {blocked ? "Заблокирован" : "Активен"}
                        </span>
                      </td>
                      {!adminsOnly ? (
                        <td className="row-menu-cell">
                          <div className="row-menu-wrap" ref={menuId === u.id ? menuRef : undefined}>
                            <button
                              type="button"
                              className="row-menu-btn"
                              aria-label="Действия"
                              onClick={() => setMenuId((id) => (id === u.id ? null : u.id))}
                            >
                              ⋯
                            </button>
                            {menuId === u.id && (
                              <div className="row-menu">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setMenuId(null);
                                    setConfirm({ kind: blocked ? "unblock" : "block", user: u });
                                  }}
                                >
                                  {blocked ? "Разблокировать" : "Блокировать"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setMenuId(null);
                                    setConfirm({ kind: "password", user: u });
                                  }}
                                >
                                  Сбросить пароль
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > visible && (
            <button type="button" className="btn secondary small text-btn" onClick={() => setVisible((n) => n + USER_PAGE)}>
              Показать ещё · {filtered.length - visible}
            </button>
          )}
        </>
      )}
      {createOpen && (
        <div className="modal-backdrop" onClick={() => !creating && setCreateOpen(false)} role="presentation">
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <p className="kicker">Создание</p>
            <h2 className="display" style={{ fontSize: 26 }}>
              {adminsOnly ? "Новый администратор" : "Новый пользователь"}
            </h2>
            <form className="grid" onSubmit={submit}>
              <label>
                Email
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </label>
              <label>
                Имя
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              {!adminsOnly && (
                <label>
                  Роль
                  <select required value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    {roleOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Компания
                <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              </label>
              <label>
                Телефон
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </label>
              <label>
                Пароль
                <input
                  required
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </label>
              <div className="row-actions">
                <button className="btn" type="submit" disabled={creating}>
                  {adminsOnly ? "Создать администратора" : "Создать пользователя"}
                </button>
                <button className="btn secondary" type="button" disabled={creating} onClick={() => setCreateOpen(false)}>
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
              {confirm.user.name}
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
