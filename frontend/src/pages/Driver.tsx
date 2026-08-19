import { useEffect, useRef, useState } from "react";
import Empty from "../components/Empty";
import MapView from "../components/MapView";
import { useToast } from "../components/Toast";
import { api, errText } from "../api";
import type { Order, Settlement, Vehicle } from "../types";

export default function Driver() {
  const toast = useToast();
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState(0);
  const [trip, setTrip] = useState<Order | null>(null);
  const [status, setStatus] = useState("Выберите борт и разрешите геолокацию");
  const [live, setLive] = useState(false);
  const watch = useRef<number | null>(null);

  useEffect(() => {
    api<Settlement[]>("/api/geo/settlements").then(setSettlements);
    api<Vehicle[]>("/api/geo/vehicles").then((v) => {
      setVehicles(v);
      if (v[0]) setVehicleId(v[0].id);
    });
    const es = new EventSource("/api/tracking/stream");
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "fleet") setVehicles(data.vehicles);
    };
    return () => {
      es.close();
      if (watch.current != null) navigator.geolocation.clearWatch(watch.current);
    };
  }, []);

  const current = vehicles.find((v) => v.id === vehicleId);

  useEffect(() => {
    if (!current?.current_order_id) {
      setTrip(null);
      return;
    }
    api<Order>(`/api/orders/${current.current_order_id}`)
      .then(setTrip)
      .catch(() => setTrip(null));
  }, [current?.current_order_id]);

  function start() {
    if (!navigator.geolocation) {
      setStatus("Геолокация недоступна в этом браузере");
      toast.err("Геолокация недоступна");
      return;
    }
    setLive(true);
    setStatus("Идёт передача координат…");
    watch.current = navigator.geolocation.watchPosition(
      async (pos) => {
        try {
          await api("/api/tracking/ping", {
            method: "POST",
            body: JSON.stringify({
              vehicle_id: vehicleId,
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
            }),
          });
          setStatus(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
        } catch (e) {
          toast.err(errText(e));
        }
      },
      (e) => {
        setLive(false);
        setStatus(e.message);
        toast.err(e.message);
      },
      { enableHighAccuracy: true, maximumAge: 3000 }
    );
  }

  function stop() {
    if (watch.current != null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    setLive(false);
    setStatus("Трансляция остановлена");
  }

  return (
    <div className="page split">
      <aside className="side">
        <p className="kicker">Водитель · GPS</p>
        <h2 className="display" style={{ fontSize: 34 }}>
          Рейс и геолокация
        </h2>
        <p className="lede">
          Координаты с телефона идут на ту же карту, что видит диспетчер. Пока идут live-пакеты,
          симулятор этой машины молчит.
        </p>
        <label>
          Борт
          <select value={vehicleId} onChange={(e) => setVehicleId(Number(e.target.value))}>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.plate} · {v.driver_name}
              </option>
            ))}
          </select>
        </label>
        {trip ? (
          <div className="card" style={{ marginTop: 16 }}>
            <span className={`badge ${trip.status}`}>{trip.status === "transit" ? "в пути" : trip.status}</span>
            <h3>
              {trip.origin_name} → {trip.dest_name}
            </h3>
            <div className="meta">
              <span>{trip.cargo_title}</span>
              <span>{trip.weight_kg} кг</span>
              <span>{trip.distance_km} км</span>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <Empty title="Сейчас без груза" hint="Когда диспетчер или перевозчик назначит рейс, он появится здесь." />
          </div>
        )}
        <div className="row-actions">
          {!live ? (
            <button className="btn" onClick={start}>
              Начать трансляцию
            </button>
          ) : (
            <button className="btn secondary" onClick={stop}>
              Остановить
            </button>
          )}
        </div>
        <p className="lede" style={{ marginTop: 16 }}>
          {live ? "Live · " : ""}
          {status}
        </p>
      </aside>
      <MapView settlements={settlements} vehicles={vehicles} />
    </div>
  );
}
