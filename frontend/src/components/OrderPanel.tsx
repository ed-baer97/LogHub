import type { ReactNode } from "react";
import { useToast } from "./Toast";
import { STATUS_RU } from "../lib/labels";
import type { Order } from "../types";

export default function OrderPanel({
  order,
  onShowOnMap,
  extra,
}: {
  order: Order;
  onShowOnMap: () => void;
  extra?: ReactNode;
}) {
  const toast = useToast();
  return (
    <div className="card order-panel">
      <span className={`badge ${order.status}`}>{STATUS_RU[order.status] ?? order.status}</span>
      {order.is_backhaul && <span className="badge back">обратка</span>}
      <h3>
        {order.origin_name} → {order.dest_name}
      </h3>
      <p className="lede" style={{ marginBottom: 8 }}>
        {order.cargo_title}
      </p>
      <div className="meta">
        <span>{order.weight_kg} кг</span>
        <span>{order.distance_km} км</span>
        <span>{order.price_offered.toLocaleString("ru-KZ")} ₸</span>
        {order.plate && <span>{order.plate}</span>}
      </div>
      {order.sender_name && <p className="lede">Отправитель: {order.sender_name}</p>}
      {order.empty_km_saved > 0 && (
        <p className="lede">Экономия порожняка: {order.empty_km_saved} км</p>
      )}
      <div className="row-actions">
        <button
          className="btn secondary small"
          onClick={() => {
            onShowOnMap();
            toast.ok("Маршрут на карте");
          }}
        >
          Показать на карте
        </button>
        {extra}
      </div>
    </div>
  );
}
