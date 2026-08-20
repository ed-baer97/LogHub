# Жизненный цикл заявки

3 / 10 · [← Роли и доступ](roles-and-access.md) · [Оглавление](../README.md) · [Интерфейс →](frontend.md)

## Граф статусов

```mermaid
stateDiagram-v2
  [*] --> open
  open --> taken: take
  taken --> assigned: assign
  assigned --> arrived: arrive
  arrived --> loading: start-loading
  loading --> transit: start-route
  transit --> delivered: complete-route / конец polyline
  delivered --> [*]
  open --> cancelled: cancel
  taken --> cancelled: cancel
  assigned --> cancelled: cancel
  cancelled --> [*]
```

В API статус в пути — `transit` (не `IN_TRANSIT`). Legacy-алиас `pickup` в коде приравнивается к погрузке.

Пропускать этапы нельзя: `assigned` → `transit` даёт 409.

## Кто двигает статус

```mermaid
sequenceDiagram
  actor Sender as Отправитель
  actor Carrier as Перевозчик
  actor Driver as Водитель
  participant API as FastAPI
  Sender->>API: POST /api/orders  open
  Carrier->>API: POST /take  taken
  Carrier->>API: POST /assign  assigned
  Driver->>API: POST /arrive  arrived
  Driver->>API: POST /start-loading  loading
  Driver->>API: POST /start-route  transit + OSRM
  Driver->>API: POST /complete-route  delivered
```

| Шаг | Кто | Эндпоинт / действие |
|-----|-----|---------------------|
| Разместить | отправитель | `POST /api/orders` |
| Править / удалить `open` | отправитель | `PATCH` / `DELETE /api/orders/{id}` |
| Отменить `open`, `taken`, `assigned` | отправитель | `POST /api/orders/{id}/cancel` |
| Взять с биржи | перевозчик | `POST /api/orders/{id}/take` |
| Назначить idle-борт | перевозчик | `POST /api/orders/{id}/assign` |
| «Я прибыл» | водитель | `POST /api/tracking/arrive` |
| «Начать погрузку» | водитель | `POST /api/tracking/start-loading` |
| «Выехать» | водитель | `POST /api/tracking/start-route` — строится маршрут, стартует движение |
| «Завершить рейс» | водитель | `POST /api/tracking/complete-route` |
| Остановить анимацию (борт остаётся в рейсе) | водитель | `POST /api/tracking/stop-route` |

## Что происходит на шаге

### `open`

На бирже. Цена: если `price_offered` не задан — берётся рекомендация. Дистанция из OSRM/кэша.

### `taken`

`carrier_id` = текущий перевозчик, `taken_at` сейчас. Чужие перевозчики заявку больше не видят. Борт ещё не занят.

### `assigned`

Свободный активный борт компании с водителем. Проверка веса. Если матчер находит попутку относительно базы борта — пишутся `empty_km_saved` и `is_backhaul`. `vehicle.current_order_id` = заявка, статус борта `assigned`. Повторный assign до прибытия можно сменить борт (старый освобождается).

### `arrived`

Водитель на месте погрузки. Отмена отправителем уже запрещена. Борт остаётся `assigned`.

### `loading`

Погрузка. Статус борта `loading`.

### `transit`

OSRM polyline в Redis, борт в начало маршрута, статус борта `enroute`. Тик симулятора пишет след. Опционально GPS: `POST /api/tracking/ping`.

`stop-route` снимает план движения, заявка остаётся `transit`, борт `enroute` без анимации.

### `delivered`

Борт `idle`, `current_order_id` пустой, `delivered_at` задан. Тот же исход, если симулятор доехал до конца polyline.

### `cancelled`

Только до `arrived`. `release_bort`: план сима сброшен, борт свободен.

## Карта по этапам

```mermaid
flowchart LR
  S1["open / taken"] --> M1["пункты, без живого борта"]
  S2["assigned / arrived / loading"] --> M2["борт в точке, без polyline"]
  S3["transit"] --> M3["polyline + движение / GPS"]
  S4["delivered"] --> M4["рейс закрыт"]
```

| Статус | Что на карте |
|--------|----------------|
| `open` / `taken` | пункты, без живого борта у отправителя |
| `assigned` / `arrived` / `loading` | борт в точке (ещё без polyline движения) |
| `transit` | polyline + движение / GPS |
| `delivered` | рейс закрыт |

Цепочка с нуля — в [быстром старте](getting-started.md).
