import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Empty, { Skeleton } from "../components/Empty";
import MapView from "../components/MapView";
import { useToast } from "../components/Toast";
import { api, errText, getStoredUser } from "../api";
import { STATUS_RU } from "../lib/labels";
import type { Analytics, Order, Settlement, User, Vehicle } from "../types";

type Tab = "overview" | "orders" | "fleet" | "users" | "places";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Обзор" },
  { id: "orders", label: "Заявки" },
  { id: "fleet", label: "Автопарк" },
  { id: "users", label: "Пользователи" },
  { id: "places", label: "Пункты" },
];

const VEHICLE_KINDS = [
  { id: "tent", label: "Тент" },
  { id: "reefer", label: "Рефрижератор" },
  { id: "dump", label: "Самосвал" },
  { id: "flatbed", label: "Платформа" },
];

const ROLE_LABELS: Record<string, string> = {
  sender: "Отправитель",
  carrier: "Перевозчик",
  driver: "Водитель",
  admin: "Админ",
  superadmin: "Супер-админ",
  dispatcher: "Админ",
};

const PLACE_KINDS = [
  { id: "city", label: "Город" },
  { id: "village", label: "Посёлок" },
  { id: "industrial", label: "Промзона" },
  { id: "construction", label: "Стройка" },
];

export default function Dispatcher() {
  const toast = useToast();
  const me = getStoredUser();
  const isSuper = me?.role === "superadmin";
  const tabs = isSuper
    ? ([
        { id: "overview", label: "Дашборд" },
        { id: "users", label: "Админы" },
      ] as { id: Tab; label: string }[])
    : TABS;
  const [tab, setTab] = useState<Tab>("overview");
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
    const es = new EventSource("/api/tracking/stream");
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

  async function act(path: string, body?: unknown, okMsg = "Сохранено") {
    try {
      await api(path, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
      toast.ok(okMsg);
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  return (
    <div style={{ padding: "20px 22px 40px" }}>
      <p className="kicker">{isSuper ? "Супер-админ · дашборд системы" : "Акимат · админ-панель"}</p>
      {isSuper && (
        <p className="lede">
          Только просмотр грузопотоков и создание админов. Заявки, парк и пункты не редактируются.
        </p>
      )}
      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <Overview
          stats={stats}
          settlements={settlements}
          vehicles={vehicles}
          routes={routes}
          orders={orders}
          users={users}
          systemWide={isSuper}
        />
      )}
      {tab === "orders" && !isSuper && <OrdersTab orders={orders} vehicles={vehicles} act={act} />}
      {tab === "fleet" && !isSuper && (
        <FleetTab
          vehicles={vehicles}
          users={users}
          settlements={settlements}
          orders={orders}
          reload={reload}
        />
      )}
      {tab === "users" && <UsersTab users={users} reload={reload} adminsOnly={isSuper} />}
      {tab === "places" && !isSuper && <PlacesTab settlements={settlements} reload={reload} />}
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
}: {
  stats: Analytics | null;
  settlements: Settlement[];
  vehicles: Vehicle[];
  routes: { id: string; coords: number[][] }[];
  orders: Order[];
  users: User[];
  systemWide: boolean;
}) {
  const byRole = (role: string) => users.filter((u) => u.role === role).length;
  const live = vehicles.filter((v) => v.live).length;

  return (
    <div>
      {systemWide && (
        <div className="stats" style={{ marginTop: 16 }}>
          <div className="stat">
            <b>{byRole("admin") + byRole("dispatcher")}</b>
            <span>админов</span>
          </div>
          <div className="stat">
            <b>{byRole("sender")}</b>
            <span>отправителей</span>
          </div>
          <div className="stat">
            <b>{byRole("carrier")}</b>
            <span>перевозчиков</span>
          </div>
          <div className="stat">
            <b>{byRole("driver")}</b>
            <span>водителей</span>
          </div>
          <div className="stat">
            <b>{vehicles.length}</b>
            <span>машин в парке</span>
          </div>
          <div className="stat">
            <b>{live}</b>
            <span>live GPS</span>
          </div>
          <div className="stat">
            <b>{orders.filter((o) => o.status === "open").length}</b>
            <span>открытых заявок</span>
          </div>
          <div className="stat">
            <b>{orders.filter((o) => o.status === "transit").length}</b>
            <span>в рейсе</span>
          </div>
        </div>
      )}
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
                <b>{stats.empty_km_without_platform.toFixed(0)}</b>
                <span>км порожняка без платформы</span>
              </div>
              <div className="stat">
                <b>{stats.empty_km_with_platform.toFixed(0)}</b>
                <span>км порожняка с LogHub</span>
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
        <MapView settlements={settlements} vehicles={vehicles} routes={routes} />
      </div>
    </div>
  );
}

function OrdersTab({
  orders,
  vehicles,
  act,
}: {
  orders: Order[];
  vehicles: Vehicle[];
  act: (path: string, body?: unknown, okMsg?: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState("all");
  const [assign, setAssign] = useState<Record<number, number>>({});
  const free = vehicles.filter((v) => !v.current_order_id);
  const shown = orders.filter((o) => filter === "all" || o.status === filter);

  return (
    <div style={{ marginTop: 16 }}>
      <div className="row-actions" style={{ marginBottom: 12 }}>
        {["all", "open", "transit", "delivered", "cancelled"].map((f) => (
          <button
            key={f}
            className={`btn small ${filter === f ? "" : "secondary"}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "все" : STATUS_RU[f]}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Маршрут</th>
            <th>Груз</th>
            <th>кг</th>
            <th>км</th>
            <th>₸</th>
            <th>Статус</th>
            <th>Машина</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td colSpan={9}>
                <Empty title="Нет заявок в этом фильтре" />
              </td>
            </tr>
          ) : (
            shown.map((o) => (
            <tr key={o.id}>
              <td>{o.id}</td>
              <td>
                {o.origin_name} → {o.dest_name}
              </td>
              <td>{o.cargo_title}</td>
              <td>{o.weight_kg}</td>
              <td>{o.distance_km}</td>
              <td>{o.price_offered.toLocaleString("ru-KZ")}</td>
              <td>
                <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
              </td>
              <td>{o.plate ?? "—"}</td>
              <td>
                <div className="row-actions" style={{ marginTop: 0 }}>
                  {o.status === "open" && (
                    <>
                      <select
                        value={assign[o.id] ?? 0}
                        onChange={(e) => setAssign({ ...assign, [o.id]: Number(e.target.value) })}
                      >
                        <option value={0}>машина…</option>
                        {free
                          .filter((v) => v.capacity_kg >= o.weight_kg)
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.plate} · {v.capacity_kg} кг
                            </option>
                          ))}
                      </select>
                      <button
                        className="btn small"
                        disabled={!assign[o.id]}
                        onClick={() => act(`/api/admin/orders/${o.id}/assign`, { vehicle_id: assign[o.id] }, "Машина назначена")}
                      >
                        Назначить
                      </button>
                    </>
                  )}
                  {(o.status === "transit" || o.status === "taken") && (
                    <>
                      <button className="btn small" onClick={() => act(`/api/admin/orders/${o.id}/deliver`, undefined, "Доставка закрыта")}>
                        Доставлено
                      </button>
                      <button
                        className="btn secondary small"
                        onClick={() => act(`/api/admin/orders/${o.id}/reopen`)}
                      >
                        На биржу
                      </button>
                    </>
                  )}
                  {o.status !== "delivered" && o.status !== "cancelled" && (
                    <button
                      className="btn dust small"
                      onClick={() => {
                        if (window.confirm(`Отменить заявку #${o.id}?`)) {
                          act(`/api/admin/orders/${o.id}/cancel`, undefined, "Заявка отменена");
                        }
                      }}
                    >
                      Отменить
                    </button>
                  )}
                  {o.status === "cancelled" && (
                    <button className="btn secondary small" onClick={() => act(`/api/admin/orders/${o.id}/reopen`)}>
                      Вернуть на биржу
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function FleetTab({
  vehicles,
  users,
  settlements,
  orders,
  reload,
}: {
  vehicles: Vehicle[];
  users: User[];
  settlements: Settlement[];
  orders: Order[];
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const carriers = users.filter((u) => u.role === "carrier");
  const [form, setForm] = useState({
    plate: "",
    kind: "tent",
    capacity_kg: 10000,
    owner_id: 0,
    driver_name: "",
    home_id: 0,
  });
  const orderById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);

  useEffect(() => {
    setForm((f) => ({
      ...f,
      owner_id: f.owner_id || carriers[0]?.id || 0,
      home_id: f.home_id || settlements[0]?.id || 0,
    }));
  }, [carriers, settlements]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/api/admin/vehicles", { method: "POST", body: JSON.stringify(form) });
      toast.ok(`Машина ${form.plate} добавлена`);
      setForm({ ...form, plate: "", driver_name: "" });
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  async function remove(v: Vehicle) {
    if (!window.confirm(`Удалить борт ${v.plate} из парка?`)) return;
    try {
      await api(`/api/admin/vehicles/${v.id}`, { method: "DELETE" });
      toast.ok(`Машина ${v.plate} удалена`);
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  return (
    <div className="admin-cols" style={{ marginTop: 16 }}>
      <div>
        <table>
          <thead>
            <tr>
              <th>Борт</th>
              <th>Тип</th>
              <th>кг</th>
              <th>Водитель</th>
              <th>Владелец</th>
              <th>Статус</th>
              <th>Рейс</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => {
              const o = v.current_order_id ? orderById.get(v.current_order_id) : null;
              const owner = users.find((u) => u.id === v.owner_id);
              return (
                <tr key={v.id}>
                  <td>{v.plate}</td>
                  <td>{VEHICLE_KINDS.find((k) => k.id === v.kind)?.label ?? v.kind}</td>
                  <td>{v.capacity_kg}</td>
                  <td>{v.driver_name}</td>
                  <td>{owner?.company ?? owner?.name ?? "—"}</td>
                  <td>
                    <span className={`badge ${v.status === "enroute" ? "transit" : "delivered"}`}>
                      {v.live ? "live GPS" : v.status === "enroute" ? "в рейсе" : "свободна"}
                    </span>
                  </td>
                  <td>{o ? `${o.origin_name} → ${o.dest_name}` : "—"}</td>
                  <td>
                    <button className="btn dust small" onClick={() => remove(v)} disabled={!!v.current_order_id}>
                      Удалить
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Добавить машину</h3>
        <form className="grid" onSubmit={submit}>
          <label>
            Госномер
            <input
              required
              value={form.plate}
              placeholder="12 MG 34"
              onChange={(e) => setForm({ ...form, plate: e.target.value })}
            />
          </label>
          <label>
            Тип кузова
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {VEHICLE_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Грузоподъёмность, кг
            <input
              type="number"
              value={form.capacity_kg}
              onChange={(e) => setForm({ ...form, capacity_kg: Number(e.target.value) })}
            />
          </label>
          <label>
            Водитель
            <input
              required
              value={form.driver_name}
              onChange={(e) => setForm({ ...form, driver_name: e.target.value })}
            />
          </label>
          <label>
            Владелец (перевозчик)
            <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: Number(e.target.value) })}>
              {carriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company ?? c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            База
            <select value={form.home_id} onChange={(e) => setForm({ ...form, home_id: Number(e.target.value) })}>
              {settlements.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="submit">
            Добавить в парк
          </button>
        </form>
      </div>
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
  const [form, setForm] = useState({ email: "", name: "", role: "", company: "", phone: "" });
  const shown = adminsOnly ? users.filter((u) => u.role === "admin" || u.role === "dispatcher") : users;

  useEffect(() => {
    api<{ id: string; label: string }[]>("/api/admin/role-options").then((rows) => {
      setOptions(rows);
      setForm((f) => ({ ...f, role: f.role || rows[0]?.id || "" }));
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify(form) });
      toast.ok(`Пользователь ${form.email} создан (пароль demo)`);
      setForm({ email: "", name: "", role: options[0]?.id || "", company: "", phone: "" });
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  return (
    <div className="admin-cols" style={{ marginTop: 16 }}>
      <div>
        <table>
          <thead>
            <tr>
              <th>Имя</th>
              <th>Email</th>
              <th>Роль</th>
              <th>Компания</th>
              <th>Телефон</th>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>{adminsOnly ? "Новый админ" : "Новый пользователь"}</h3>
        <p className="lede">
          {me?.role === "superadmin"
            ? "Супер-админ создаёт только админов. Правки системы им недоступны."
            : "Админ создаёт отправителей, перевозчиков и водителей. Создать админа нельзя."}
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
          <label>
            Компания
            <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </label>
          <label>
            Телефон
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </label>
          <button className="btn" type="submit">
            Создать
          </button>
        </form>
      </div>
    </div>
  );
}

function PlacesTab({
  settlements,
  reload,
}: {
  settlements: Settlement[];
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: "",
    kind: "village",
    lat: 43.65,
    lon: 51.2,
    population: 0,
    note: "",
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/api/admin/settlements", { method: "POST", body: JSON.stringify(form) });
      toast.ok(`Пункт «${form.name}» добавлен`);
      setForm({ ...form, name: "", note: "" });
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  async function remove(s: Settlement) {
    if (!window.confirm(`Удалить пункт «${s.name}»?`)) return;
    try {
      await api(`/api/admin/settlements/${s.id}`, { method: "DELETE" });
      toast.ok(`Пункт «${s.name}» удалён`);
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  return (
    <div className="admin-cols" style={{ marginTop: 16 }}>
      <div>
        <table>
          <thead>
            <tr>
              <th>Название</th>
              <th>Тип</th>
              <th>Координаты</th>
              <th>Население</th>
              <th>Примечание</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {settlements.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{PLACE_KINDS.find((k) => k.id === s.kind)?.label ?? s.kind}</td>
                <td>
                  {s.lat.toFixed(3)}, {s.lon.toFixed(3)}
                </td>
                <td>{s.population || "—"}</td>
                <td>{s.note ?? "—"}</td>
                <td>
                  <button className="btn dust small" onClick={() => remove(s)}>
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Новый пункт</h3>
        <form className="grid" onSubmit={submit}>
          <label>
            Название
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Тип
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {PLACE_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Широта
            <input
              type="number"
              step="0.0001"
              value={form.lat}
              onChange={(e) => setForm({ ...form, lat: Number(e.target.value) })}
            />
          </label>
          <label>
            Долгота
            <input
              type="number"
              step="0.0001"
              value={form.lon}
              onChange={(e) => setForm({ ...form, lon: Number(e.target.value) })}
            />
          </label>
          <label>
            Население
            <input
              type="number"
              value={form.population}
              onChange={(e) => setForm({ ...form, population: Number(e.target.value) })}
            />
          </label>
          <label>
            Примечание
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <button className="btn" type="submit">
            Добавить пункт
          </button>
        </form>
      </div>
    </div>
  );
}
