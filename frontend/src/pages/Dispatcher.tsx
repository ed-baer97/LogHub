import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Empty, { Skeleton } from "../components/Empty";
import MapView from "../components/MapView";
import { useToast } from "../components/Toast";
import { api, errText, getStoredUser, streamUrl } from "../api";
import { STATUS_RU, VEHICLE_STATUS_RU } from "../lib/labels";
import type { Analytics, Order, Settlement, User, Vehicle } from "../types";

type Tab = "overview" | "users";
type SuperInfo = "senders" | "carriers" | "drivers" | "vehicles" | "live" | "open" | "transit";

const ROLE_LABELS: Record<string, string> = {
  sender: "Отправитель",
  carrier: "Перевозчик",
  driver: "Водитель",
  admin: "Админ",
  superadmin: "Супер-админ",
  dispatcher: "Админ",
};

export default function Dispatcher() {
  const toast = useToast();
  const me = getStoredUser();
  const isSuper = me?.role === "superadmin";
  const tabs = isSuper
    ? ([
        { id: "overview", label: "Дашборд" },
        { id: "users", label: "Админы" },
      ] as { id: Tab; label: string }[])
    : ([
        { id: "overview", label: "Обзор" },
        { id: "users", label: "Пользователи" },
      ] as { id: Tab; label: string }[]);
  const [tab, setTab] = useState<Tab>("overview");
  const [info, setInfo] = useState<SuperInfo | null>(null);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [stats, setStats] = useState<Analytics | null>(null);
  const [routes, setRoutes] = useState<{ id: string; coords: number[][] }[]>([]);

  const reload = useCallback(async () => {
    const [s, v, o, u, a] = await Promise.all([
      api<Settlement[]>("/api/geo/settlements"),
      api<Vehicle[]>("/api/geo/vehicles"),
      api<Order[]>("/api/orders"),
      api<User[]>("/api/admin/users"),
      api<Analytics>("/api/analytics/summary"),
    ]);
    setSettlements(s);
    setVehicles(v);
    setOrders(o);
    setUsers(u);
    setStats(a);
    const active = o.filter((x) => x.status === "transit");
    const lines = await Promise.all(
      active.map(async (item) => {
        const r = await api<{ geometry: number[][] }>(`/api/orders/${item.id}/route`);
        return { id: String(item.id), coords: r.geometry };
      })
    );
    setRoutes(lines);
  }, []);

  useEffect(() => {
    reload();
    const es = new EventSource(streamUrl("/api/tracking/stream"));
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "fleet") setVehicles(data.vehicles);
      if (data.type === "order") reload();
    };
    const t = setInterval(() => api<Analytics>("/api/analytics/summary").then(setStats), 10000);
    return () => {
      es.close();
      clearInterval(t);
    };
  }, [reload]);

  return (
    <div className={`cabinet${isSuper ? " super-cabinet" : ""}${isSuper && tab === "overview" && !info ? " map-mode" : ""}`}>
      <div className="cabinet-head">
        <div>
          <p className="kicker">{isSuper ? "Супер-админ" : "Акимат · админ-панель"}</p>
          {isSuper && <h2 className="display cabinet-title">Дашборд системы</h2>}
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
      {tab === "overview" && info && (
        <div className="super-body">
          <SuperInfo
            kind={info}
            users={users}
            vehicles={vehicles}
            orders={orders}
            onBack={() => setInfo(null)}
          />
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
          onOpenAdmins={() => setTab("users")}
          onOpenInfo={setInfo}
        />
      )}
      {tab === "users" &&
        (isSuper ? (
          <div className="super-body">
            <UsersTab users={users} reload={reload} adminsOnly />
          </div>
        ) : (
          <UsersTab users={users} reload={reload} adminsOnly={false} />
        ))}
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
  onOpenAdmins?: () => void;
  onOpenInfo?: (kind: SuperInfo) => void;
}) {
  const byRole = (role: string) => users.filter((u) => u.role === role).length;
  const live = vehicles.filter((v) => v.live).length;
  const liveOrders = orders.filter((o) => o.status === "transit" || o.status === "open").slice(0, 6);
  const [panelOpen, setPanelOpen] = useState(true);
  const [barDocked, setBarDocked] = useState(false);

  if (systemWide) {
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
                <h3>Экономика порожняка</h3>
                {!stats ? (
                  <Skeleton rows={2} />
                ) : (
                  <div className="stats eco">
                    <div className="stat">
                      <b>{stats.loaded_km.toFixed(0)}</b>
                      <span>С грузом</span>
                    </div>
                    <div className="stat">
                      <b>{stats.empty_km_with_platform.toFixed(0)}</b>
                      <span>Пустые</span>
                    </div>
                    <div className="stat">
                      <b>{stats.fuel_saved_l.toFixed(0)} л</b>
                      <span>дизель</span>
                    </div>
                    <div className="stat">
                      <b>{stats.money_saved_kzt.toLocaleString("ru-KZ")} ₸</b>
                      <span>топливо</span>
                    </div>
                  </div>
                )}
              </div>
            </aside>
            <aside className="super-side">
              <h3>Коридоры</h3>
              <table>
                <thead>
                  <tr>
                    <th>Маршрут</th>
                    <th>рейсы</th>
                    <th>км</th>
                  </tr>
                </thead>
                <tbody>
                  {(stats?.corridors ?? []).slice(0, 6).map((c) => (
                    <tr key={c.from + c.to}>
                      <td>
                        {c.from} → {c.to}
                      </td>
                      <td>{c.trips}</td>
                      <td>{c.km.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Сейчас на бирже</h3>
              <div className="card-list">
                {liveOrders.length === 0 ? (
                  <Empty title="Нет открытых и активных заявок" />
                ) : (
                  liveOrders.map((o) => (
                    <div className="card" key={o.id}>
                      <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                      {o.is_backhaul && <span className="badge back">обратка</span>}
                      <h3>
                        {o.origin_name} → {o.dest_name}
                      </h3>
                      <div className="meta">
                        <span>{o.cargo_title}</span>
                        <span>{o.plate ?? "ждёт машину"}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="dash-grid" style={{ padding: 0, marginTop: 16 }}>
        <div>
          <h2 className="display" style={{ fontSize: 32 }}>
            Грузопотоки внутри области
          </h2>
          {!stats ? (
            <Skeleton rows={4} />
          ) : (
            <div className="stats">
              <div className="stat">
                <b>{stats.loaded_km.toFixed(0)}</b>
                <span>С грузом</span>
              </div>
              <div className="stat">
                <b>{stats.empty_km_with_platform.toFixed(0)}</b>
                <span>Пустые</span>
              </div>
              <div className="stat">
                <b>{stats.fuel_saved_l.toFixed(0)} л</b>
                <span>дизель сэкономлен</span>
              </div>
              <div className="stat">
                <b>{stats.money_saved_kzt.toLocaleString("ru-KZ")} ₸</b>
                <span>топливо</span>
              </div>
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>Коридор</th>
                <th>рейсы</th>
                <th>км</th>
              </tr>
            </thead>
            <tbody>
              {stats?.corridors.map((c) => (
                <tr key={c.from + c.to}>
                  <td>
                    {c.from} → {c.to}
                  </td>
                  <td>{c.trips}</td>
                  <td>{c.km.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-list">
          {orders
            .filter((o) => o.status === "transit" || o.status === "open")
            .slice(0, 8)
            .map((o) => (
              <div className="card" key={o.id}>
                <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                {o.is_backhaul && <span className="badge back">обратка</span>}
                <h3>
                  {o.origin_name} → {o.dest_name}
                </h3>
                <div className="meta">
                  <span>{o.cargo_title}</span>
                  <span>{o.plate ?? "ждёт машину"}</span>
                </div>
              </div>
            ))}
        </div>
      </div>
      <div className="map-wrap" style={{ height: "50vh", marginTop: 16 }}>
        <MapView settlements={settlements} vehicles={systemWide ? vehicles : []} routes={systemWide ? routes : []} />
      </div>
    </div>
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

  return (
    <div>
      <div className="row-actions" style={{ marginBottom: 14 }}>
        <button type="button" className="btn secondary small" onClick={onBack}>
          ← К карте
        </button>
      </div>
      <h2 className="display cabinet-title" style={{ display: "block", fontSize: 28, marginBottom: 16 }}>
        {INFO_TITLE[kind]}
      </h2>
      {people && (
        people.length === 0 ? (
          <Empty title="Нет записей" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Имя</th>
                <th>Email</th>
                <th>Компания</th>
                <th>Телефон</th>
              </tr>
            </thead>
            <tbody>
              {people.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>{u.company ?? "—"}</td>
                  <td>{u.phone ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
      {fleet && (
        fleet.length === 0 ? (
          <Empty title="Нет машин" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Госномер</th>
                <th>Водитель</th>
                <th>Статус</th>
                <th>GPS</th>
              </tr>
            </thead>
            <tbody>
              {fleet.map((v) => (
                <tr key={v.id}>
                  <td>{v.plate}</td>
                  <td>{v.driver_name}</td>
                  <td>
                    <span className="badge">{VEHICLE_STATUS_RU[v.status] ?? v.status}</span>
                  </td>
                  <td>{v.live ? "live" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
      {jobs && (
        jobs.length === 0 ? (
          <Empty title="Нет заявок" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Маршрут</th>
                <th>Груз</th>
                <th>Статус</th>
                <th>₸</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>
                    {o.origin_name} → {o.dest_name}
                  </td>
                  <td>{o.cargo_title}</td>
                  <td>
                    <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                  </td>
                  <td>{o.price_offered.toLocaleString("ru-KZ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
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
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
  const [form, setForm] = useState({ email: "", name: "", role: "", company: "", phone: "", password: "demo", carrier_id: 0 });
  const me = getStoredUser();
  const shown = (adminsOnly ? users.filter((u) => u.role === "admin" || u.role === "dispatcher") : users).filter(
    (u) => u.id !== me?.id
  );

  useEffect(() => {
    api<{ id: string; label: string }[]>("/api/admin/role-options").then((rows) => {
      setOptions(rows);
      setForm((f) => ({ ...f, role: f.role || rows[0]?.id || "" }));
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const created = await api<User>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ ...form, role: adminsOnly ? "admin" : form.role }),
      });
      toast.ok(`Пользователь ${form.email} создан${created.initial_password ? ` · пароль ${created.initial_password}` : ""}`);
      setForm({ email: "", name: "", role: options[0]?.id || "", company: "", phone: "", password: "demo", carrier_id: 0 });
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  const createForm = (
    <div className="card">
      <h3>{adminsOnly ? "Новый админ" : "Новый пользователь"}</h3>
      <p className="lede">
        {adminsOnly
          ? "Дальше админ заводит отправителей и перевозчиков."
          : "Админ создаёт отправителей и перевозчиков. Водителей заводит перевозчик. Создать админа нельзя."}
      </p>
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
            <select
              required
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {options.map((r) => (
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
        <button className="btn" type="submit">
          Создать
        </button>
      </form>
    </div>
  );

  return (
    <div className={`admin-cols${adminsOnly ? " admins-create" : ""}`} style={{ marginTop: 16 }}>
      {adminsOnly && createForm}
      <div>
        {shown.length === 0 ? (
          <Empty title={adminsOnly ? "Пока нет админов" : "Пока нет пользователей"} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Имя</th>
                <th>Email</th>
                <th>Роль</th>
                <th>Компания</th>
                <th>Телефон</th>
                <th>Статус</th>
                {!adminsOnly ? <th></th> : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>
                    <span className="badge">{ROLE_LABELS[u.role] ?? u.role}</span>
                  </td>
                  <td>{u.company ?? "—"}</td>
                  <td>{u.phone ?? "—"}</td>
                  <td>{u.is_active === false ? "блок" : "активен"}</td>
                  {!adminsOnly ? (
                    <td>
                      <div className="row-actions" style={{ marginTop: 0 }}>
                        <button
                          type="button"
                          className="btn small secondary"
                          onClick={() =>
                            api(`/api/admin/users/${u.id}/${u.is_active === false ? "unblock" : "block"}`, {
                              method: "POST",
                              body: "{}",
                            })
                              .then(() => reload())
                              .catch((ex) => toast.err(errText(ex)))
                          }
                        >
                          {u.is_active === false ? "Разблок" : "Блок"}
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => {
                            const password = window.prompt("Новый пароль", "demo");
                            if (!password) return;
                            api(`/api/admin/users/${u.id}/reset-password`, {
                              method: "POST",
                              body: JSON.stringify({ password }),
                            })
                              .then((row) => {
                                const urow = row as User;
                                toast.ok(`Пароль сброшен${urow.initial_password ? `: ${urow.initial_password}` : ""}`);
                                return reload();
                              })
                              .catch((ex) => toast.err(errText(ex)));
                          }}
                        >
                          Пароль
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!adminsOnly && createForm}
    </div>
  );
}

