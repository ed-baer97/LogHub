import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView from "../components/MapView";
import DriverShell from "../components/DriverShell";
import { useHeaderHint } from "../components/headerHint";
import { useToast } from "../components/Toast";
import { api, apiList, errText, streamUrl } from "../api";
import { DRIVER_STAGE_RU } from "../lib/labels";
import { formatKg, kindLabel, kmBetween } from "../lib/fleet";
import type { Order, Settlement, User, Vehicle } from "../types";

const STEPS: { id: string; label: string }[] = [
  { id: "assigned", label: "Назначен" },
  { id: "arrived", label: "Прибыл" },
  { id: "loading", label: "Погрузка" },
  { id: "transit", label: "В пути" },
  { id: "delivered", label: "Завершён" },
];

const STEP_ORDER = STEPS.map((s) => s.id);

function tripCode(id: number) {
  return `#CLH-${String(id).padStart(5, "0")}`;
}

function stepIndex(status: string) {
  const i = STEP_ORDER.indexOf(status);
  return i >= 0 ? i : 0;
}

function tripPoints(trip: Order): Settlement[] {
  return [
    {
      id: trip.origin_id,
      name: trip.origin_name,
      kind: "city",
      lat: trip.origin_lat,
      lon: trip.origin_lon,
      population: 0,
      note: "Погрузка",
    },
    {
      id: trip.dest_id === trip.origin_id ? -trip.dest_id : trip.dest_id,
      name: trip.dest_name,
      kind: "industrial",
      lat: trip.dest_lat,
      lon: trip.dest_lon,
      population: 0,
      note: "Доставка",
    },
  ];
}

export default function Driver({ user }: { user: User }) {
  const toast = useToast();
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [trip, setTrip] = useState<Order | null>(null);
  const [route, setRoute] = useState<number[][]>([]);
  const [trail, setTrail] = useState<number[][]>([]);
  const [geoOn, setGeoOn] = useState(false);
  const [link, setLink] = useState<"ok" | "off">("ok");
  const [busy, setBusy] = useState(false);
  const [confirmDone, setConfirmDone] = useState(false);
  const [finished, setFinished] = useState<Order | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const watch = useRef<number | null>(null);
  const vehicleRef = useRef<Vehicle | null>(null);
  vehicleRef.current = vehicle;
  useHeaderHint(vehicle ? vehicle.plate : null);

  const loadFleet = useCallback(async () => {
    const rows = await apiList<Vehicle>("/api/geo/vehicles?limit=200");
    const mine = rows.find((v) => v.driver_id === user.id) ?? null;
    setVehicle(mine);
    return mine;
  }, [user.id]);

  useEffect(() => {
    loadFleet().catch((e) => {
      setLoadErr(true);
      toast.err(errText(e));
    });
    const es = new EventSource(streamUrl("/api/tracking/stream"));
    es.onopen = () => setLink("ok");
    es.onerror = () => setLink("off");
    es.onmessage = (ev) => {
      setLink("ok");
      const data = JSON.parse(ev.data);
      if (data.type === "fleet" && Array.isArray(data.vehicles)) {
        const rows = data.vehicles as Vehicle[];
        const mine = rows.find((v) => v.driver_id === user.id);
        if (mine) setVehicle(mine);
      }
      if (data.type === "vehicle" && data.driver_id === user.id) {
        setVehicle((prev) => (prev ? { ...prev, ...data } : (data as Vehicle)));
      }
      if (data.type === "order" || data.type === "order_new") {
        loadFleet().catch(() => undefined);
      }
    };
    return () => {
      es.close();
      if (watch.current != null) navigator.geolocation.clearWatch(watch.current);
    };
  }, [loadFleet, toast, user.id]);

  useEffect(() => {
    if (!vehicle?.current_order_id) {
      setTrip(null);
      setRoute([]);
      setTrail([]);
      return;
    }
    const oid = vehicle.current_order_id;
    api<Order>(`/api/orders/${oid}`)
      .then(setTrip)
      .catch((e) => {
        setTrip(null);
        toast.err(errText(e));
      });
    api<{ geometry: number[][] }>(`/api/orders/${oid}/route`)
      .then((r) => setRoute(r.geometry ?? []))
      .catch(() => setRoute([]));
  }, [vehicle?.current_order_id, vehicle?.status, toast]);

  useEffect(() => {
    if (!vehicle || trip?.status !== "transit") {
      setTrail([]);
      return;
    }
    api<{ lat: number; lon: number }[]>(`/api/tracking/${vehicle.id}/trail`)
      .then((pts) => setTrail(pts.map((p) => [p.lon, p.lat])))
      .catch(() => setTrail([]));
  }, [vehicle?.id, vehicle?.lat, vehicle?.lon, trip?.status]);

  function clearWatch() {
    if (watch.current != null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    setGeoOn(false);
  }

  function startWatch(v: Vehicle) {
    if (!navigator.geolocation) {
      setGeoOn(false);
      return;
    }
    clearWatch();
    watch.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const board = vehicleRef.current;
        if (!board) return;
        try {
          await api("/api/tracking/ping", {
            method: "POST",
            body: JSON.stringify({
              vehicle_id: board.id,
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
            }),
          });
          setGeoOn(true);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "";
          if (msg.includes("Слишком часто") || msg.includes("429")) {
            setGeoOn(true);
            return;
          }
          setGeoOn(false);
        }
      },
      () => setGeoOn(false),
      { enableHighAccuracy: true, maximumAge: 3000 }
    );
  }

  useEffect(() => {
    if (trip?.status === "transit" && vehicle) startWatch(vehicle);
    else clearWatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.status, vehicle?.id]);

  async function refresh() {
    const mine = await loadFleet();
    if (!mine?.current_order_id) {
      setTrip(null);
      return;
    }
    setTrip(await api<Order>(`/api/orders/${mine.current_order_id}`));
  }

  async function step(path: string, okMsg: string) {
    if (!vehicle) return;
    setBusy(true);
    try {
      await api(path, { method: "POST", body: JSON.stringify({ vehicle_id: vehicle.id }) });
      toast.ok(okMsg);
      await refresh();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function depart() {
    if (!vehicle) return;
    setBusy(true);
    try {
      await api("/api/tracking/start-route", {
        method: "POST",
        body: JSON.stringify({ vehicle_id: vehicle.id }),
      });
      toast.ok("Рейс начат");
      await refresh();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!vehicle || !trip) return;
    setBusy(true);
    try {
      const snapshot = trip;
      await api("/api/tracking/complete-route", {
        method: "POST",
        body: JSON.stringify({ vehicle_id: vehicle.id }),
      });
      clearWatch();
      setConfirmDone(false);
      setFinished(snapshot);
      setTrip(null);
      toast.ok("Доставка закрыта");
      await loadFleet();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const st = trip?.status;
  const maps = trip ? tripPoints(trip) : vehicle
    ? [
        {
          id: vehicle.home_id,
          name: "База",
          kind: "city",
          lat: vehicle.lat,
          lon: vehicle.lon,
          population: 0,
        } satisfies Settlement,
      ]
    : [];
  const routes = route.length > 1 && trip ? [{ id: String(trip.id), coords: route }] : [];
  const fitTo = useMemo(() => {
    if (!trip) return vehicle ? [[vehicle.lon, vehicle.lat]] : undefined;
    if (st === "transit") {
      return [
        [trip.dest_lon, trip.dest_lat],
        [vehicle?.lon ?? trip.origin_lon, vehicle?.lat ?? trip.origin_lat],
        ...route.filter((_, i) => i % 10 === 0),
      ];
    }
    if (st === "assigned") return [[trip.origin_lon, trip.origin_lat]];
    return [
      [trip.origin_lon, trip.origin_lat],
      [trip.dest_lon, trip.dest_lat],
    ];
  }, [trip, st, vehicle, route]);

  const remaining =
    vehicle && trip && st === "transit"
      ? kmBetween(vehicle.lat, vehicle.lon, trip.dest_lat, trip.dest_lon)
      : null;

  const cta = !trip
    ? null
    : st === "assigned"
      ? { label: "Я прибыл на место", run: () => step("/api/tracking/arrive", "Вы на погрузке"), kind: "primary" as const }
      : st === "arrived"
        ? { label: "Погрузка завершена", run: () => step("/api/tracking/start-loading", "Погрузка зафиксирована"), kind: "primary" as const }
        : st === "loading"
          ? { label: "Начать рейс", run: depart, kind: "primary" as const }
          : st === "transit"
            ? { label: "Завершить рейс", run: () => setConfirmDone(true), kind: "warn" as const }
            : null;

  const stage = trip ? DRIVER_STAGE_RU[trip.status] ?? trip.status : "Свободен";
  const idx = trip ? stepIndex(st === "pickup" ? "loading" : st ?? "assigned") : -1;

  const tripBody = finished ? (
    <div className="driver-done">
      <p className="kicker">Готово</p>
      <h2 className="display driver-title">Рейс завершён</h2>
      <p className="driver-code">{tripCode(finished.id)}</p>
      <p className="fleet-route">
        {finished.origin_name} → {finished.dest_name}
      </p>
      <p className="lede">Доставка завершена. Следующий рейс появится, когда его назначит перевозчик.</p>
      <button type="button" className="btn driver-cta" onClick={() => setFinished(null)}>
        Понятно
      </button>
    </div>
  ) : loadErr && !vehicle ? (
    <div className="driver-idle">
      <h2 className="display driver-title">Не удалось загрузить рейс</h2>
      <p className="lede">Проверьте связь и обновите страницу.</p>
      <button
        type="button"
        className="btn driver-cta"
        onClick={() => {
          setLoadErr(false);
          loadFleet().catch((e) => {
            setLoadErr(true);
            toast.err(errText(e));
          });
        }}
      >
        Повторить
      </button>
    </div>
  ) : !vehicle ? (
    <div className="driver-idle">
      <h2 className="display driver-title">Нет закреплённого борта</h2>
      <p className="lede">Перевозчик создаёт борт и назначает вас водителем. Пока действий не требуется.</p>
    </div>
  ) : !trip ? (
    <div className="driver-idle">
      <h2 className="display driver-title">Нет активного рейса</h2>
      <p className="lede">Сейчас вам не назначен рейс. Как только перевозчик назначит рейс, он появится здесь.</p>
      <div className="card">
        <p className="kicker">Ваш борт</p>
        <h3>
          {kindLabel(vehicle.kind)} · {vehicle.plate}
        </h3>
        <span className="fleet-badge idle">
          <i />
          Свободен
        </span>
      </div>
    </div>
  ) : (
    <>
      <p className="kicker">Рейс {tripCode(trip.id)}</p>
      <ol className="driver-steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i < idx ? "done" : i === idx ? "now" : ""}>
            <i />
            {s.label}
          </li>
        ))}
      </ol>
      <span
        className={`fleet-badge ${st === "assigned" ? "assigned" : st === "transit" ? "transit" : st === "loading" ? "idle" : "loading"}`}
      >
        <i />
        {stage}
      </span>
      {st === "transit" ? (
        <>
          <h2 className="display driver-title">{trip.dest_name}</h2>
          <p className="driver-point-label">Пункт назначения</p>
        </>
      ) : (
        <>
          <h2 className="display driver-title">{trip.origin_name}</h2>
          <p className="driver-point-label">Пункт погрузки</p>
          <div className="driver-arrow">↓</div>
          <h3 className="driver-dest">{trip.dest_name}</h3>
          <p className="driver-point-label">Пункт доставки</p>
        </>
      )}

      {st === "loading" ? (
        <p className="lede" style={{ marginTop: 16 }}>
          Погрузка завершена. Маршрут {trip.origin_name} → {trip.dest_name}
          {trip.distance_km ? ` · ${trip.distance_km.toFixed(0)} км` : ""}.
        </p>
      ) : null}

      {st === "transit" && remaining != null ? (
        <>
          <div className="driver-live">
            <div>
              <b>{trip.dest_name}</b>
              <span>Пункт назначения</span>
            </div>
            <div>
              <b>{remaining.toFixed(0)} км</b>
              <span>Осталось</span>
            </div>
            {trip.distance_km ? (
              <div>
                <b>{trip.distance_km.toFixed(0)} км</b>
                <span>Весь путь</span>
              </div>
            ) : null}
          </div>
          <p className="lede" style={{ marginTop: 10 }}>
            {trip.cargo_title} · {formatKg(trip.weight_kg)}
          </p>
        </>
      ) : (
        <div className="driver-facts">
          <div>
            <span>Груз</span>
            <b>{trip.cargo_title}</b>
          </div>
          <div>
            <span>Вес</span>
            <b>{formatKg(trip.weight_kg)}</b>
          </div>
          {trip.distance_km ? (
            <div>
              <span>Расстояние</span>
              <b>{trip.distance_km.toFixed(0)} км</b>
            </div>
          ) : null}
          {trip.created_at ? (
            <div>
              <span>Создан</span>
              <b>{new Date(trip.created_at).toLocaleString("ru-KZ")}</b>
            </div>
          ) : null}
        </div>
      )}

      <div className="card driver-bort-mini">
        <span className="kicker" style={{ margin: 0 }}>
          Ваш борт
        </span>
        <strong>
          {kindLabel(vehicle.kind)} · {vehicle.plate}
        </strong>
      </div>

      {cta ? (
        <button
          type="button"
          className={`btn driver-cta${cta.kind === "warn" ? " dust" : ""}`}
          disabled={busy}
          onClick={cta.run}
        >
          {cta.label}
        </button>
      ) : null}
    </>
  );

  return (
    <DriverShell mapMode>
      <div className="super-dash driver-stage">
        <MapView
          settlements={finished ? [] : maps}
          vehicles={vehicle && !finished ? [vehicle] : []}
          routes={finished ? [] : routes}
          trail={st === "transit" ? trail : []}
          fitTo={finished ? undefined : fitTo}
          navPosition="bottom-right"
        />
        <button
          type="button"
          className={`btn small super-panel-toggle${panelOpen ? " on-panel" : ""}`}
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
        >
          {panelOpen ? "Скрыть" : "Рейс"}
        </button>
        {panelOpen && (
          <div className="super-hud driver-hud">
            <aside className="driver-sheet">
              <div className="driver-topline">
                <span className={`driver-link${link === "ok" ? " on" : ""}`}>
                  {link === "ok" ? "Связь есть" : "Нет связи"}
                </span>
                <span className={`driver-geo${geoOn ? " on" : ""}`}>
                  {geoOn ? "Геолокация активна" : "Геолокация отключена"}
                </span>
              </div>
              {tripBody}
            </aside>
          </div>
        )}
        {!panelOpen && cta ? (
          <div className="driver-cta-dock">
            <button
              type="button"
              className={`btn driver-cta${cta.kind === "warn" ? " dust" : ""}`}
              disabled={busy}
              onClick={cta.run}
            >
              {cta.label}
            </button>
          </div>
        ) : null}
      </div>

      {confirmDone && trip ? (
        <div className="modal-backdrop" onClick={() => !busy && setConfirmDone(false)} role="presentation">
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <p className="kicker">Подтверждение</p>
            <h2 className="display" style={{ fontSize: 28 }}>
              Завершить рейс?
            </h2>
            <p className="lede">
              {trip.origin_name} → {trip.dest_name}
            </p>
            <div className="row-actions">
              <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirmDone(false)}>
                Отмена
              </button>
              <button type="button" className="btn dust driver-cta" disabled={busy} onClick={complete}>
                Завершить рейс
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </DriverShell>
  );
}
