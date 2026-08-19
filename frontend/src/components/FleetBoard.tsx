import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, errText } from "../api";
import {
  FLEET_STATUS_RU,
  VEHICLE_KINDS,
  fleetUiStatus,
  formatKg,
  kindLabel,
  tripForVehicle,
  tripProgress,
  type FleetUiStatus,
} from "../lib/fleet";
import type { Order, Settlement, Vehicle } from "../types";
import Empty from "./Empty";
import { useToast } from "./Toast";

type Filter = "all" | FleetUiStatus;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "idle", label: "Свободны" },
  { id: "assigned", label: "Назначены" },
  { id: "loading", label: "На погрузке" },
  { id: "transit", label: "В пути" },
  { id: "inactive", label: "Неактивны" },
];

const emptyCreate = {
  plate: "",
  kind: "tent",
  capacity_kg: 10000,
  home_id: 0,
  driver_name: "",
  driver_email: "",
  driver_phone: "",
};

type CreateForm = typeof emptyCreate;

type EditForm = {
  plate: string;
  kind: string;
  capacity_kg: number;
  home_id: number;
  driver_name: string;
  driver_email: string;
  driver_phone: string;
  driver_password: string;
  driver_active: boolean;
};

export default function FleetBoard({
  vehicles,
  trips,
  settlements,
  reload,
  onOpenTrip,
  compact = false,
}: {
  vehicles: Vehicle[];
  trips: Order[];
  settlements: Settlement[];
  reload: () => Promise<void>;
  onOpenTrip?: () => void;
  compact?: boolean;
}) {
  const toast = useToast();
  const bases = settlements.filter((s) => !s.sender_id);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [edit, setEdit] = useState<Vehicle | null>(null);
  const [detail, setDetail] = useState<Vehicle | null>(null);
  const [form, setForm] = useState<CreateForm>(emptyCreate);

  useEffect(() => {
    setForm((f) => ({ ...f, home_id: f.home_id || bases[0]?.id || 0 }));
  }, [bases]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setCreateOpen(false);
      setEdit(null);
      setDetail(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stats = useMemo(() => {
    const rows = vehicles.map((v) => fleetUiStatus(v, tripForVehicle(v, trips)));
    return {
      all: vehicles.length,
      idle: rows.filter((s) => s === "idle").length,
      work: rows.filter((s) => s === "assigned" || s === "loading" || s === "transit").length,
      wait: rows.filter((s) => s === "assigned").length,
    };
  }, [vehicles, trips]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return vehicles.filter((v) => {
      const status = fleetUiStatus(v, tripForVehicle(v, trips));
      if (filter !== "all" && status !== filter) return false;
      if (!needle) return true;
      const blob = [v.plate, v.driver_name, v.driver_phone, v.driver_email, String(v.id)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return blob.includes(needle);
    });
  }, [vehicles, trips, q, filter]);

  async function addBort(e: FormEvent) {
    e.preventDefault();
    try {
      const created = await api<Vehicle>("/api/fleet/borts", { method: "POST", body: JSON.stringify(form) });
      toast.ok(
        created.initial_password
          ? `Борт ${created.plate} создан. Пароль водителя: ${created.initial_password}`
          : `Борт ${created.plate} создан`
      );
      setForm({ ...emptyCreate, home_id: bases[0]?.id || 0, kind: form.kind });
      setCreateOpen(false);
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  function openAdd() {
    setForm({ ...emptyCreate, home_id: bases[0]?.id || 0 });
    setCreateOpen(true);
  }

  if (compact) {
    if (vehicles.length === 0) return <Empty title="Нет бортов" />;
    return (
      <div className="fleet-grid">
        {vehicles.map((v) => (
          <FleetCard
            key={v.id}
            v={v}
            trip={tripForVehicle(v, trips)}
            settlements={settlements}
            onOpen={() => setDetail(v)}
            onEdit={() => setEdit(v)}
            onOpenTrip={onOpenTrip}
          />
        ))}
        {edit && (
          <EditModal
            v={edit}
            bases={bases}
            trips={trips}
            onClose={() => setEdit(null)}
            reload={reload}
          />
        )}
        {detail && (
          <DetailDrawer
            v={vehicles.find((x) => x.id === detail.id) ?? detail}
            trip={tripForVehicle(vehicles.find((x) => x.id === detail.id) ?? detail, trips)}
            settlements={settlements}
            onClose={() => setDetail(null)}
            onEdit={() => {
              const current = vehicles.find((x) => x.id === detail.id) ?? detail;
              setDetail(null);
              setEdit(current);
            }}
            onOpenTrip={onOpenTrip}
          />
        )}
      </div>
    );
  }

  return (
    <div className="fleet-board">
      <div className="fleet-head">
        <div>
          <h2 className="display cabinet-title" style={{ display: "block", fontSize: 28, margin: 0 }}>
            Парк
          </h2>
          <p className="lede" style={{ margin: "6px 0 0" }}>
            Управление автомобилями и водителями
          </p>
        </div>
        <button type="button" className="btn" onClick={openAdd}>
          + Добавить борт
        </button>
      </div>

      <div className="fleet-stats">
        <div className="stat">
          <b>{stats.all}</b>
          <span>Все борта</span>
        </div>
        <div className="stat">
          <b>{stats.idle}</b>
          <span>Свободны</span>
        </div>
        <div className="stat">
          <b>{stats.work}</b>
          <span>В работе</span>
        </div>
        <div className="stat">
          <b>{stats.wait}</b>
          <span>Ожидают погрузку</span>
        </div>
      </div>

      <div className="fleet-toolbar">
        <input
          className="fleet-search"
          placeholder="Поиск борта или водителя"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="fleet-filters">
          {FILTERS.map((f) => (
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

      {shown.length === 0 ? (
        <Empty
          title={vehicles.length === 0 ? "Нет бортов" : "Ничего не найдено"}
          hint={vehicles.length === 0 ? "Добавьте первый борт — машину и водителя." : "Смените фильтр или запрос."}
        />
      ) : (
        <div className="fleet-grid">
          {shown.map((v) => (
            <FleetCard
              key={v.id}
              v={v}
              trip={tripForVehicle(v, trips)}
              settlements={settlements}
              onOpen={() => setDetail(v)}
              onEdit={() => setEdit(v)}
              onOpenTrip={onOpenTrip}
            />
          ))}
        </div>
      )}

      {createOpen && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)} role="presentation">
          <div className="modal fleet-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <p className="kicker">Парк</p>
            <h2 className="display" style={{ fontSize: 26, marginBottom: 12 }}>
              Добавить борт
            </h2>
            <form className="grid" onSubmit={addBort}>
              <label>
                Госномер
                <input required value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} />
              </label>
              <label>
                Тип
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
                  required
                  value={form.capacity_kg}
                  onChange={(e) => setForm({ ...form, capacity_kg: Number(e.target.value) })}
                />
              </label>
              <label>
                База
                <select value={form.home_id} onChange={(e) => setForm({ ...form, home_id: Number(e.target.value) })}>
                  {bases.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Водитель
                <input required value={form.driver_name} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} />
              </label>
              <label>
                Email водителя
                <input
                  required
                  type="email"
                  value={form.driver_email}
                  onChange={(e) => setForm({ ...form, driver_email: e.target.value })}
                />
              </label>
              <label>
                Телефон
                <input value={form.driver_phone} onChange={(e) => setForm({ ...form, driver_phone: e.target.value })} />
              </label>
              <div className="row-actions">
                <button type="button" className="btn secondary" onClick={() => setCreateOpen(false)}>
                  Отмена
                </button>
                <button className="btn" type="submit">
                  Создать борт
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {edit && (
        <EditModal v={edit} bases={bases} trips={trips} onClose={() => setEdit(null)} reload={reload} />
      )}

      {detail && (
        <DetailDrawer
          v={vehicles.find((x) => x.id === detail.id) ?? detail}
          trip={tripForVehicle(vehicles.find((x) => x.id === detail.id) ?? detail, trips)}
          settlements={settlements}
          onClose={() => setDetail(null)}
          onEdit={() => {
            const current = vehicles.find((x) => x.id === detail.id) ?? detail;
            setDetail(null);
            setEdit(current);
          }}
          onOpenTrip={onOpenTrip}
        />
      )}
    </div>
  );
}

function FleetCard({
  v,
  trip,
  settlements,
  onOpen,
  onEdit,
  onOpenTrip,
}: {
  v: Vehicle;
  trip?: Order;
  settlements: Settlement[];
  onOpen: () => void;
  onEdit: () => void;
  onOpenTrip?: () => void;
}) {
  const status = fleetUiStatus(v, trip);
  const home = settlements.find((s) => s.id === v.home_id)?.name;
  const progress = trip && status === "transit" ? tripProgress(v, trip) : null;

  return (
    <article className={`card fleet-card status-${status}`} onClick={onOpen}>
      <span className={`fleet-badge ${status}`}>
        <i />
        {FLEET_STATUS_RU[status]}
      </span>
      <h3>
        №{v.id} · {v.driver_name}
      </h3>
      {status === "idle" || status === "inactive" ? (
        <>
          <p className="fleet-sub">
            {kindLabel(v.kind)} · {v.plate}
          </p>
          <p className="fleet-sub">{formatKg(v.capacity_kg)}</p>
          <div className="fleet-lines">
            <span>{v.driver_name}</span>
            {v.driver_phone ? <span>{v.driver_phone}</span> : null}
            {home ? <span>База: {home}</span> : null}
          </div>
        </>
      ) : (
        <>
          {trip ? (
            <>
              <p className="fleet-route">
                {trip.origin_name} → {trip.dest_name}
              </p>
              <p className="fleet-sub">Рейс №{trip.id}</p>
              {status === "assigned" && <p className="fleet-sub">Ожидает прибытия на погрузку</p>}
              {status === "loading" && (
                <>
                  <p className="fleet-sub">Груз: {trip.cargo_title}</p>
                  <p className="fleet-sub">{trip.status === "arrived" ? "Водитель прибыл" : "Погрузка идёт"}</p>
                </>
              )}
              {status === "transit" && progress && (
                <div className="fleet-progress">
                  <div className="fleet-bar">
                    <span style={{ width: `${progress.pct}%` }} />
                  </div>
                  <p className="fleet-sub">
                    {progress.pct}% · {progress.doneKm.toFixed(0)} км из {trip.distance_km.toFixed(0)} · осталось{" "}
                    {progress.remainingKm.toFixed(0)} км
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="fleet-sub">{kindLabel(v.kind)} · {formatKg(v.capacity_kg)}</p>
          )}
        </>
      )}
      <div className="row-actions">
        {status === "idle" || status === "inactive" || !onOpenTrip ? (
          <button type="button" className="btn small" onClick={(e) => { e.stopPropagation(); onEdit(); }}>
            Изменить
          </button>
        ) : (
          <button
            type="button"
            className="btn small"
            onClick={(e) => {
              e.stopPropagation();
              onOpenTrip();
            }}
          >
            Открыть рейс
          </button>
        )}
      </div>
    </article>
  );
}

function EditModal({
  v,
  bases,
  trips,
  onClose,
  reload,
}: {
  v: Vehicle;
  bases: Settlement[];
  trips: Order[];
  onClose: () => void;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const trip = tripForVehicle(v, trips);
  const status = fleetUiStatus(v, trip);
  const [edit, setEdit] = useState<EditForm>({
    plate: v.plate,
    kind: v.kind,
    capacity_kg: v.capacity_kg,
    home_id: v.home_id,
    driver_name: v.driver_name,
    driver_email: v.driver_email ?? "",
    driver_phone: v.driver_phone ?? "",
    driver_password: "",
    driver_active: v.driver_active !== false,
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const body: Record<string, unknown> = {
        plate: edit.plate,
        kind: edit.kind,
        capacity_kg: edit.capacity_kg,
        home_id: edit.home_id,
        driver_name: edit.driver_name,
        driver_email: edit.driver_email,
        driver_phone: edit.driver_phone || null,
        driver_active: edit.driver_active,
      };
      if (edit.driver_password.trim()) body.driver_password = edit.driver_password.trim();
      const saved = await api<Vehicle>(`/api/fleet/borts/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      toast.ok(
        saved.initial_password
          ? `Сохранено. Новый пароль водителя: ${saved.initial_password}`
          : "Борт и водитель обновлены"
      );
      onClose();
      await reload();
    } catch (ex) {
      toast.err(errText(ex));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal fleet-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p className="kicker">Редактирование</p>
        <h2 className="display" style={{ fontSize: 24, marginBottom: 6 }}>
          Борт №{v.id} · {v.driver_name}
        </h2>
        <p className="lede" style={{ marginBottom: 14 }}>
          Сейчас: {FLEET_STATUS_RU[status]}
        </p>
        <form className="grid" onSubmit={save}>
          <p className="fleet-section">Машина</p>
          <label>
            Госномер
            <input required value={edit.plate} onChange={(e) => setEdit({ ...edit, plate: e.target.value })} />
          </label>
          <label>
            Тип
            <select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
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
              value={edit.capacity_kg}
              onChange={(e) => setEdit({ ...edit, capacity_kg: Number(e.target.value) })}
            />
          </label>
          <label>
            База
            <select value={edit.home_id} onChange={(e) => setEdit({ ...edit, home_id: Number(e.target.value) })}>
              {bases.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <p className="fleet-section">Водитель</p>
          <label>
            Имя
            <input required value={edit.driver_name} onChange={(e) => setEdit({ ...edit, driver_name: e.target.value })} />
          </label>
          <label>
            Телефон
            <input value={edit.driver_phone} onChange={(e) => setEdit({ ...edit, driver_phone: e.target.value })} />
          </label>
          <label>
            Email
            <input
              required
              type="email"
              value={edit.driver_email}
              onChange={(e) => setEdit({ ...edit, driver_email: e.target.value })}
            />
          </label>
          <label>
            Новый пароль
            <input
              placeholder="оставьте пустым, если не менять"
              value={edit.driver_password}
              onChange={(e) => setEdit({ ...edit, driver_password: e.target.value })}
            />
          </label>
          <label>
            Учётка водителя
            <select
              value={edit.driver_active ? "1" : "0"}
              onChange={(e) => setEdit({ ...edit, driver_active: e.target.value === "1" })}
            >
              <option value="1">активна</option>
              <option value="0">заблокирована</option>
            </select>
          </label>
          <div className="row-actions">
            {v.active !== false && !v.current_order_id ? (
              <button
                type="button"
                className="btn small dust"
                onClick={() =>
                  api(`/api/fleet/borts/${v.id}/disable`, { method: "POST", body: "{}" })
                    .then(async () => {
                      toast.ok("Борт отключён");
                      onClose();
                      await reload();
                    })
                    .catch((ex) => toast.err(errText(ex)))
                }
              >
                Отключить борт
              </button>
            ) : null}
            <button type="button" className="btn secondary" onClick={onClose}>
              Отмена
            </button>
            <button className="btn" type="submit">
              Сохранить
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DetailDrawer({
  v,
  trip,
  settlements,
  onClose,
  onEdit,
  onOpenTrip,
}: {
  v: Vehicle;
  trip?: Order;
  settlements: Settlement[];
  onClose: () => void;
  onEdit: () => void;
  onOpenTrip?: () => void;
}) {
  const status = fleetUiStatus(v, trip);
  const home = settlements.find((s) => s.id === v.home_id)?.name;

  return (
    <div className="modal-backdrop fleet-drawer-scrim" onClick={onClose} role="presentation">
      <aside className="fleet-drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn secondary small fleet-drawer-close" onClick={onClose}>
          Закрыть
        </button>
        <h2 className="display" style={{ fontSize: 24, margin: "8px 0 10px" }}>
          Борт №{v.id} · {v.driver_name}
        </h2>
        <span className={`fleet-badge ${status}`}>
          <i />
          {FLEET_STATUS_RU[status]}
        </span>
        <p className="fleet-route" style={{ marginTop: 14 }}>
          {kindLabel(v.kind)} · {v.plate}
        </p>
        <h3 className="fleet-section">Водитель</h3>
        <p className="fleet-sub">{v.driver_name}</p>
        {v.driver_phone ? <p className="fleet-sub">{v.driver_phone}</p> : null}
        {v.driver_email ? <p className="fleet-sub">{v.driver_email}</p> : null}
        <h3 className="fleet-section">Характеристики</h3>
        <p className="fleet-sub">Тип: {kindLabel(v.kind)}</p>
        <p className="fleet-sub">Грузоподъёмность: {formatKg(v.capacity_kg)}</p>
        {home ? <p className="fleet-sub">База: {home}</p> : null}
        {trip ? (
          <>
            <h3 className="fleet-section">Текущий рейс</h3>
            <p className="fleet-route">
              {trip.origin_name} → {trip.dest_name}
            </p>
            <p className="fleet-sub">Рейс №{trip.id}</p>
            <p className="fleet-sub">{trip.cargo_title}</p>
          </>
        ) : null}
        <div className="row-actions">
          <button type="button" className="btn" onClick={onEdit}>
            Редактировать
          </button>
          {trip && onOpenTrip ? (
            <button type="button" className="btn secondary" onClick={onOpenTrip}>
              Открыть рейс
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
