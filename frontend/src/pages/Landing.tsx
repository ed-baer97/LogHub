import { useEffect, useState } from "react";
import { Skeleton } from "../components/Empty";
import { api } from "../api";
import type { Analytics } from "../types";

export default function Landing({ onOpenLogin }: { onOpenLogin: () => void }) {
  const [stats, setStats] = useState<Analytics | null>(null);

  useEffect(() => {
    api<Analytics>("/api/analytics/summary").then(setStats).catch(() => setStats(null));
  }, []);

  return (
    <div className="about">
      <section className="about-hero">
        <p className="kicker">Мангистауская область</p>
        <h2 className="display">Caspian LogHub — биржа внутрирегиональных грузоперевозок</h2>
        <p className="lede">
          Цифровая платформа последнего километра: магазины, фермы и стройки находят машину, перевозчик
          закрывает порожний возврат, акимат видит грузопотоки. Не порт и не международный транзит —
          только перевозки внутри области.
        </p>
        <button className="btn" type="button" onClick={onOpenLogin}>
          Войти в кабинет
        </button>
      </section>

      <section>
        <p className="kicker">Проблема</p>
        <h3 className="about-h">Почему логистика в регионе буксует</h3>
        <div className="about-grid">
          <article className="card">
            <h3>Нет биржи</h3>
            <p className="lede">Груз ищут через звонки и мессенджеры, машины простаивают без загрузки.</p>
          </article>
          <article className="card">
            <h3>Нет GPS</h3>
            <p className="lede">Заказчик не знает, где груз и когда он приедет в отдалённый посёлок.</p>
          </article>
          <article className="card">
            <h3>Порожний пробег</h3>
            <p className="lede">После доставки в Жанаозен, Шетпе или Сенек машина часто возвращается пустой.</p>
          </article>
          <article className="card">
            <h3>Нет картины для акимата</h3>
            <p className="lede">Нет данных о внутриобластных грузопотоках для планирования дорог.</p>
          </article>
        </div>
      </section>

      <section>
        <p className="kicker">Решение</p>
        <h3 className="about-h">Что делает платформа</h3>
        <div className="about-grid">
          <article className="card">
            <h3>Биржа заявок</h3>
            <p className="lede">Отправитель размещает груз между реальными пунктами Мангистау, перевозчик берёт заказ.</p>
          </article>
          <article className="card">
            <h3>Живой трекинг</h3>
            <p className="lede">Карта автопарка, маршруты по дорогам, GPS с телефона водителя.</p>
          </article>
          <article className="card">
            <h3>Попутные грузы</h3>
            <p className="lede">Алгоритм коридора маршрута считает крюк и сэкономленные километры порожняка.</p>
          </article>
          <article className="card">
            <h3>Аналитика</h3>
            <p className="lede">Админ видит коридоры, экономию топлива и может управлять парком и заявками.</p>
          </article>
        </div>
      </section>

      <section>
        <p className="kicker">Кабинеты</p>
        <h3 className="about-h">Роли и кто кого создаёт</h3>
        <div className="about-grid">
          <article className="card">
            <h3>Супер-админ</h3>
            <p className="lede">Дашборд системы целиком. Создаёт админов. Заявки, парк и пункты не правит.</p>
          </article>
          <article className="card">
            <h3>Админ</h3>
            <p className="lede">Админка: заявки, парк, пункты. Создаёт отправителей, перевозчиков и водителей. Другого админа создать не может.</p>
          </article>
          <article className="card">
            <h3>Отправитель</h3>
            <p className="lede">Создание заявки, расчёт цены по км и типу груза, статус и трек доставки.</p>
          </article>
          <article className="card">
            <h3>Перевозчик</h3>
            <p className="lede">Лента биржи, подсказки попуток, взятие заказа на конкретную машину.</p>
          </article>
          <article className="card">
            <h3>Водитель</h3>
            <p className="lede">Карточка рейса и трансляция геолокации на общую карту.</p>
          </article>
        </div>
      </section>

      <section>
        <p className="kicker">Эффект</p>
        <h3 className="about-h">Экономика порожнего пробега</h3>
        <p className="lede">
          Без цифровой биржи холостой возврат в регионе оцениваем около 40% пробега. Платформа подбирает
          обратную загрузку в коридоре маршрута. Дизель 32 л / 100 км, 295 ₸/л.
        </p>
        {!stats ? (
          <Skeleton rows={2} />
        ) : (
          <div className="stats">
            <div className="stat">
              <b>{stats.settlements}</b>
              <span>пунктов Мангистау в справочнике</span>
            </div>
            <div className="stat">
              <b>{Math.round(stats.empty_km_saved)}</b>
              <span>км порожняка уже сэкономлено в данных</span>
            </div>
            <div className="stat">
              <b>{stats.fuel_saved_l.toFixed(0)} л</b>
              <span>дизель</span>
            </div>
            <div className="stat">
              <b>{stats.money_saved_kzt.toLocaleString("ru-KZ")} ₸</b>
              <span>на топливе</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
