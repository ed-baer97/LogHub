import { useEffect, useMemo, useState } from "react";
import { MetricCard } from "../components/Charts";
import DriverShell from "../components/DriverShell";
import Empty from "../components/Empty";
import { useToast } from "../components/Toast";
import { api, errText } from "../api";
import { formatKg } from "../lib/fleet";
import { fmtNum } from "../lib/format";
import { STATUS_RU } from "../lib/labels";
import type { Order } from "../types";

function money(n: number) {
  return `${n.toLocaleString("ru-KZ")} ₸`;
}

function tripCode(id: number) {
  return `#CLH-${String(id).padStart(5, "0")}`;
}

function when(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-KZ");
}

function inMonth(iso: string | null | undefined, now: Date) {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

export default function DriverHistory() {
  const toast = useToast();
  const [orders, setOrders] = useState<Order[] | null>(null);

  useEffect(() => {
    api<Order[]>("/api/orders")
      .then(setOrders)
      .catch((e) => {
        toast.err(errText(e));
        setOrders([]);
      });
  }, [toast]);

  const stats = useMemo(() => {
    const rows = orders ?? [];
    const done = rows.filter((o) => o.status === "delivered");
    const live = rows.filter((o) => !["delivered", "cancelled", "open"].includes(o.status));
    const now = new Date();
    const month = done.filter((o) => inMonth(o.delivered_at ?? o.created_at, now));
    return {
      all: rows.length,
      done: done.length,
      live: live.length,
      km: done.reduce((s, o) => s + (o.distance_km || 0), 0),
      pay: done.reduce((s, o) => s + (o.price_offered || 0), 0),
      monthPay: month.reduce((s, o) => s + (o.price_offered || 0), 0),
      monthTrips: month.length,
    };
  }, [orders]);

  const payouts = (orders ?? []).filter((o) => o.status === "delivered");
  const history = orders ?? [];

  return (
    <DriverShell>
      <div className="super-body">
        <div className="analytics-page">
          <header className="admin-hero">
            <h2 className="display">История</h2>
            <p className="lede">
              Рейсы вашего борта. Оплата — сумма заявки, которую указал отправитель. Банковских списаний в системе нет.
            </p>
          </header>

          <section>
            <h3 className="analytics-kicker">Рейсы</h3>
            <div className="metric-grid analytics-now">
              <MetricCard name="Завершено" value={fmtNum(stats.done)} unit="рейсов" />
              <MetricCard name="В работе" value={fmtNum(stats.live)} unit="рейсов" />
              <MetricCard name="С грузом" value={fmtNum(stats.km)} unit="км" />
              <MetricCard name="Начислено" value={fmtNum(stats.pay)} unit="₸" />
            </div>
          </section>
          <section>
            <h3 className="analytics-kicker">Этот месяц</h3>
            <div className="metric-grid analytics-now">
              <MetricCard name="Рейсов" value={fmtNum(stats.monthTrips)} unit="шт" />
              <MetricCard name="Начислено" value={fmtNum(stats.monthPay)} unit="₸" />
              <MetricCard name="Всего на борту" value={fmtNum(stats.all)} unit="рейсов" />
            </div>
          </section>

          <section className="driver-dash-block">
            <h3 className="fleet-section">Оплата по завершённым рейсам</h3>
            {orders === null ? (
              <p className="lede">Загрузка…</p>
            ) : payouts.length === 0 ? (
              <Empty title="Пока нет начислений" hint="Сумма появится после завершённого рейса." />
            ) : (
              <div className="card-list">
                {payouts.map((o) => (
                  <div className="card" key={o.id}>
                    <span className="badge delivered">начислено</span>
                    <h3>
                      {money(o.price_offered)} · {tripCode(o.id)}
                    </h3>
                    <div className="meta">
                      <span>
                        {o.origin_name} → {o.dest_name}
                      </span>
                      <span>{o.cargo_title}</span>
                      <span>{when(o.delivered_at ?? o.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="driver-dash-block">
            <h3 className="fleet-section">История заказов</h3>
            {orders === null ? (
              <p className="lede">Загрузка…</p>
            ) : history.length === 0 ? (
              <Empty title="История пуста" hint="Когда перевозчик назначит рейс, он появится здесь." />
            ) : (
              <div className="card-list">
                {history.map((o) => (
                  <div className="card" key={o.id}>
                    <span className={`badge ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
                    <h3>
                      {o.origin_name} → {o.dest_name}
                    </h3>
                    <div className="meta">
                      <span>{tripCode(o.id)}</span>
                      <span>{o.cargo_title}</span>
                      <span>{formatKg(o.weight_kg)}</span>
                      {o.distance_km ? <span>{o.distance_km.toFixed(0)} км</span> : null}
                      <span>{money(o.price_offered)}</span>
                      {o.plate ? <span>{o.plate}</span> : null}
                      <span>{when(o.delivered_at ?? o.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </DriverShell>
  );
}
