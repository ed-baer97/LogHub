import { useEffect, useRef, useState } from "react";
import Empty from "../components/Empty";
import MapView from "../components/MapView";
import { useToast } from "../components/Toast";
import { api, errText, streamUrl } from "../api";
import { STATUS_RU } from "../lib/labels";
import type { Order, Settlement, User, Vehicle } from "../types";

export default function Driver({ user }: { user: User }) {
  const toast = useToast();
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [trip, setTrip] = useState<Order | null>(null);
  const [route, setRoute] = useState<number[][]>([]);
  const [status, setStatus] = useState("Ждём назначение рейса на ваш борт.");
  const [live, setLive] = useState(false);
  const watch = useRef<number | null>(null);

  const current = vehicles.find((v) => v.driver_id === user.id) ?? vehicles[0] ?? null;

  useEffect(() => {
    api<Settlement[]>("/api/geo/settlements").then(setSettlements);
    api<Vehicle[]>("/api/geo/vehicles").then(setVehicles);
    const es = new EventSource(streamUrl("/api/tracking/stream"));
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "fleet") setVehicles(data.vehicles ?? []);
      if (data.type === "order") {
        api<Vehicle[]>("/api/geo/vehicles").then(setVehicles).catch(() => undefined);
      }
    };
    return () => {
      es.close();
      if (watch.current != null) navigator.geolocation.clearWatch(watch.current);
    };
  }, []);

  useEffect(() => {
    if (!current?.current_order_id) {
      setTrip(null);
      setRoute([]);
      setLive(false);
      return;
    }
    api<Order>(`/api/orders/${current.current_order_id}`)
      .then(setTrip)
      .catch(() => setTrip(null));
    api<{ geometry: number[][] }>(`/api/orders/${current.current_order_id}/route`)
      .then((r) => setRoute(r.geometry ?? []))
      .catch(() => setRoute([]));
  }, [current?.current_order_id, current?.status]);

  function clearWatch() {
    if (watch.current != null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
  }

  async function refreshTrip() {
    if (!current?.current_order_id) return;
    const next = await api<Order>(`/api/orders/${current.current_order_id}`);
    setTrip(next);
    setVehicles(await api<Vehicle[]>("/api/geo/vehicles"));
  }

  async function step(path: string, okMsg: string) {
    if (!current) return;
    try {
      await api(path, { method: "POST", body: JSON.stringify({ vehicle_id: current.id }) });
      toast.ok(okMsg);
      await refreshTrip();
    } catch (e) {
      toast.err(errText(e));
    }
  }

  async function depart() {
    if (!current) return;
    try {
      await api("/api/tracking/start-route", {
        method: "POST",
        body: JSON.stringify({ vehicle_id: current.id }),
      });
      setLive(true);
      setStatus("Выехали. Маршрут по навигатору.");
      toast.ok("В пути");
      await refreshTrip();
    } catch (e) {
      toast.err(errText(e));
      return;
    }
    if (!navigator.geolocation) return;
    watch.current = navigator.geolocation.watchPosition(
      async (pos) => {
        try {
          await api("/api/tracking/ping", {
            method: "POST",
            body: JSON.stringify({
              vehicle_id: current.id,
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
            }),
          });
          setStatus(`Live GPS · ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
        } catch (err) {
          toast.err(errText(err));
        }
      },
      () => setStatus("Движение по навигатору (геолокация недоступна)"),
      { enableHighAccuracy: true, maximumAge: 3000 }
    );
  }

  async function complete() {
    if (!current) return;
    try {
      await api("/api/tracking/complete-route", {
        method: "POST",
        body: JSON.stringify({ vehicle_id: current.id }),
      });
      clearWatch();
      setLive(false);
      setTrip(null);
      setStatus("Рейс завершён. Борт свободен.");
      toast.ok("Доставка закрыта");
      setVehicles(await api<Vehicle[]>("/api/geo/vehicles"));
    } catch (e) {
      toast.err(errText(e));
    }
  }

  const routes = trip?.status === "transit" && route.length > 1 ? [{ id: String(trip.id), coords: route }] : [];
  const mapVehicles = current ? [current] : [];
  const st = trip?.status;

  return (
    <div className="page split">
      <aside className="side">
        <p className="kicker">Водитель · мой борт</p>
        <h2 className="display" style={{ fontSize: 34 }}>
          Рейс
        </h2>
        <p className="lede">
          Этапы по порядку: прибыл → погрузка → выехать → завершить. Пропускать нельзя. GPS с телефона не обязателен.
        </p>
        {current ? (
          <div className="card">
            <span className={`badge ${current.status === "enroute" ? "transit" : "delivered"}`}>{current.plate}</span>
            <h3>{current.driver_name}</h3>
            <div className="meta">
              <span>{current.kind}</span>
              <span>{current.capacity_kg} кг</span>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <Empty title="Нет закреплённого борта" hint="Перевозчик создаёт борт и назначает вас водителем." />
          </div>
        )}
        {trip ? (
          <div className="card" style={{ marginTop: 16 }}>
            <span className={`badge ${trip.status}`}>{STATUS_RU[trip.status] ?? trip.status}</span>
            <h3>
              {trip.origin_name} → {trip.dest_name}
            </h3>
            <div className="meta">
              <span>{trip.cargo_title}</span>
              <span>{trip.weight_kg} кг</span>
              <span>{trip.distance_km} км</span>
            </div>
          </div>
        ) : current ? (
          <div style={{ marginTop: 16 }}>
            <Empty title="Сейчас без груза" hint="Когда перевозчик назначит рейс, он появится здесь." />
          </div>
        ) : null}
        <div className="row-actions">
          {st === "assigned" ? (
            <button className="btn" onClick={() => step("/api/tracking/arrive", "Прибыли на погрузку")}>
              Я прибыл на погрузку
            </button>
          ) : null}
          {st === "arrived" ? (
            <button className="btn" onClick={() => step("/api/tracking/start-loading", "Погрузка начата")}>
              Начать погрузку
            </button>
          ) : null}
          {st === "loading" ? (
            <button className="btn" onClick={depart}>
              Выехать
            </button>
          ) : null}
          {st === "transit" ? (
            <button className="btn" onClick={complete}>
              Завершить рейс
            </button>
          ) : null}
        </div>
        <p className="lede" style={{ marginTop: 16 }}>
          {live ? "В пути · " : ""}
          {status}
        </p>
      </aside>
      <MapView settlements={settlements} vehicles={mapVehicles} routes={routes} />
    </div>
  );
}
