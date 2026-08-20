import { useEffect, useMemo, useState, type MouseEvent } from "react";
import MapView, { type NetworkDot } from "../components/MapView";
import { useTheme } from "../theme";
import type { Settlement } from "../types";

type Corridor = { id: string; origin: string; dest: string; coords: number[][] };

const SHOW_PLACES = ["Актау", "Жанаозен", "Шетпе", "Бейнеу", "Форт-Шевченко", "Курык"];
const DEMO_WAYS: [string, string, string][] = [
  ["Актау-Жанаозен", "Актау", "Жанаозен"],
  ["Актау-Шетпе", "Актау", "Шетпе"],
  ["Шетпе-Бейнеу", "Шетпе", "Бейнеу"],
  ["Актау-Форт-Шевченко", "Актау", "Форт-Шевченко"],
  ["Актау-Курык", "Актау", "Курык"],
  ["Жанаозен-Шетпе", "Жанаозен", "Шетпе"],
];
const OSRM_URL = "https://router.project-osrm.org";

function byName(points: Settlement[], name: string) {
  return points.find((p) => p.name === name);
}

function lerp(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function along(coords: number[][], t: number): number[] {
  if (coords.length < 2) return coords[0] ?? [51.2, 43.65];
  const x = ((t % 1) + 1) % 1;
  let total = 0;
  const segs: number[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const d = Math.hypot(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]);
    segs.push(d);
    total += d;
  }
  if (total <= 0) return coords[0];
  let remain = x * total;
  for (let i = 0; i < segs.length; i++) {
    if (remain <= segs[i]) {
      const local = segs[i] === 0 ? 0 : remain / segs[i];
      return lerp(coords[i], coords[i + 1], local);
    }
    remain -= segs[i];
  }
  return coords[coords.length - 1];
}

function looksLikeRoad(coords: number[][]) {
  if (coords.length >= 32) return true;
  if (coords.length < 8) return false;
  const a = coords[0];
  const b = coords[coords.length - 1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return false;
  const step = Math.max(1, Math.floor(coords.length / 48));
  for (let i = 1; i < coords.length - 1; i += step) {
    const p = coords[i];
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    const dist = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    if (dist > 0.008) return true;
  }
  return false;
}

async function fetchRoadLine(olon: number, olat: number, dlon: number, dlat: number): Promise<number[][] | null> {
  try {
    const r = await fetch(
      `${OSRM_URL}/route/v1/driving/${olon},${olat};${dlon},${dlat}?overview=full&geometries=geojson`
    );
    if (!r.ok) return null;
    const data = await r.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    return Array.isArray(coords) && looksLikeRoad(coords) ? coords : null;
  } catch {
    return null;
  }
}

function onSectionLink(e: MouseEvent<HTMLAnchorElement>) {
  const href = e.currentTarget.getAttribute("href");
  if (!href?.startsWith("#") || href.length < 2) return;
  const target = document.getElementById(href.slice(1));
  const scroller = document.querySelector(".land-app");
  if (!target || !(scroller instanceof HTMLElement)) return;
  e.preventDefault();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (href === "#top") {
    scroller.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  } else {
    const top =
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 88;
    scroller.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  }
  history.replaceState(null, "", href);
}

export default function Landing({ onOpenLogin }: { onOpenLogin: () => void }) {
  const { theme, toggle } = useTheme();
  const [points, setPoints] = useState<Settlement[]>([]);
  const [roads, setRoads] = useState<Corridor[]>([]);
  const [osrmRoads, setOsrmRoads] = useState<Corridor[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/geo/catalog")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Settlement[]) => setPoints(rows))
      .catch(() => setPoints([]));
    fetch("/api/geo/corridors")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Corridor[]) => setRoads(Array.isArray(rows) ? rows : []))
      .catch(() => setRoads([]));
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 160);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (roads.some((r) => looksLikeRoad(r.coords))) return;
    if (!points.length) return;
    let cancelled = false;
    Promise.all(
      DEMO_WAYS.map(async ([id, origin, dest]) => {
        const a = byName(points, origin);
        const b = byName(points, dest);
        if (!a || !b) return null;
        const coords = await fetchRoadLine(a.lon, a.lat, b.lon, b.lat);
        return coords ? { id, origin, dest, coords } : null;
      })
    ).then((rows) => {
      if (cancelled) return;
      setOsrmRoads(rows.filter((x): x is Corridor => Boolean(x)));
    });
    return () => {
      cancelled = true;
    };
  }, [roads, points]);

  const corridors = useMemo(() => {
    const fromApi = roads.filter((r) => looksLikeRoad(r.coords));
    return fromApi.length ? fromApi : osrmRoads;
  }, [roads, osrmRoads]);

  const routes = useMemo(
    () => corridors.map((c) => ({ id: c.id, coords: c.coords })),
    [corridors]
  );

  const visiblePlaces = useMemo(
    () => points.filter((p) => SHOW_PLACES.includes(p.name)),
    [points]
  );

  const networkDots = useMemo(() => {
    const dots: NetworkDot[] = [];
    corridors.forEach((c, i) => {
      const t = (tick / (200 + i * 28) + i * 0.18) % 1;
      const p = along(c.coords, t);
      dots.push({ id: `run-${i}`, lon: p[0], lat: p[1], tone: "transit" });
    });
    const aktau = byName(points, "Актау");
    const zhana = byName(points, "Жанаозен");
    const shetpe = byName(points, "Шетпе");
    const beineu = byName(points, "Бейнеу");
    if (aktau) {
      dots.push({ id: "idle-a", lon: aktau.lon - 0.07, lat: aktau.lat + 0.05, tone: "idle" });
      dots.push({ id: "load-a", lon: aktau.lon + 0.05, lat: aktau.lat - 0.03, tone: "load" });
    }
    if (zhana) dots.push({ id: "ord-z", lon: zhana.lon - 0.04, lat: zhana.lat + 0.04, tone: "order" });
    if (shetpe) dots.push({ id: "idle-s", lon: shetpe.lon + 0.06, lat: shetpe.lat + 0.02, tone: "idle" });
    if (beineu) dots.push({ id: "ord-b", lon: beineu.lon - 0.05, lat: beineu.lat - 0.03, tone: "order" });
    return dots;
  }, [corridors, points, tick]);

  const aktau = useMemo(() => byName(points, "Актау"), [points]);
  const mapCenter: [number, number] = aktau ? [aktau.lon, aktau.lat] : [51.1975, 43.6588];

  const map = visiblePlaces.length > 0 && (
    <MapView
      settlements={visiblePlaces}
      vehicles={[]}
      routes={routes}
      networkDots={networkDots}
      center={mapCenter}
      zoom={8}
      mapTheme={theme}
      legend="none"
      showControls={false}
      className="land-net"
      locked
    />
  );

  return (
    <div className="land" id="top">
      <div className="land-map">{map}</div>
      <div className="land-veil" />

      <header className="land-nav">
        <a className="land-brand" href="#top" onClick={onSectionLink}>
          <span className="land-mark" aria-hidden />
          Caspian LogHub
        </a>
        <nav>
          <a href="#find-cargo" onClick={onSectionLink}>Найти груз</a>
          <a href="#carriers" onClick={onSectionLink}>Перевозчикам</a>
          <a href="#drivers" onClick={onSectionLink}>Водителям</a>
          <a href="#how" onClick={onSectionLink}>Как это работает</a>
        </nav>
        <div className="land-nav-actions">
          <button
            className="btn secondary small theme-toggle"
            type="button"
            onClick={toggle}
            aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}
            title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          >
            {theme === "dark" ? "Светлая" : "Тёмная"}
          </button>
          <button className="btn small" type="button" onClick={onOpenLogin}>
            Войти
          </button>
        </div>
      </header>

      <section className="land-hero">
        <div className="land-copy">
          <p className="kicker">Мангистау · Каспий</p>
          <h1 className="display">
            Грузы. Перевозчики. Водители.
            <br />
            В одном маршруте.
          </h1>
          <p className="lede">Цифровая биржа грузоперевозок Мангистау — от заявки до доставки.</p>
          <div className="land-cta">
            <a className="btn" href="#find-cargo" onClick={onSectionLink}>
              Найти перевозку
            </a>
            <a className="btn secondary" href="#carriers" onClick={onSectionLink}>
              Стать перевозчиком
            </a>
          </div>
          <p className="land-stats">12 активных рейсов · 37 заявок · 84 перевозчика</p>
        </div>

        <aside className="land-float f1">
          <p className="kicker">Активный рейс</p>
          <strong>Актау → Жанаозен</strong>
          <span>18 т · тент</span>
          <em className="land-live">В пути</em>
        </aside>
        <aside className="land-float f2">
          <p className="kicker">Погрузка</p>
          <strong>Актау</strong>
          <span>Сегодня · 14:30</span>
        </aside>
        <aside className="land-float f3">
          <p className="kicker">Свободные машины</p>
          <strong>12 автомобилей</strong>
          <span>в радиусе Актау</span>
        </aside>
      </section>

      <section className="land-section" id="find-cargo">
        <p className="kicker">Отправитель</p>
        <h2 className="land-h">Найти перевозку по Мангистау</h2>
        <p className="lede land-section-lede">
          Создайте заявку: откуда, куда, тоннаж и тип кузова. Платформа подбирает перевозчика по маршруту Актау, Жанаозен, Шетпе и Бейнеу.
        </p>
        <ul className="land-facts">
          <li>
            <h3>Заявка</h3>
            <p>Маршрут, груз и окно погрузки — в одной форме.</p>
          </li>
          <li>
            <h3>Подбор</h3>
            <p>Свободные машины рядом с точкой погрузки.</p>
          </li>
          <li>
            <h3>Сопровождение</h3>
            <p>Статус рейса от назначения водителя до выгрузки.</p>
          </li>
        </ul>
      </section>

      <section className="land-section" id="carriers">
        <p className="kicker">Перевозчик</p>
        <h2 className="land-h">Заказы, парк и водители</h2>
        <p className="lede land-section-lede">
          Кабинет перевозчика собирает входящие заявки, автомобили и назначения. Диспетчер видит, кто свободен и кто уже в рейсе.
        </p>
        <ul className="land-facts">
          <li>
            <h3>Лента заказов</h3>
            <p>Заявки по области, без обзвона и переписок в мессенджерах.</p>
          </li>
          <li>
            <h3>Автопарк</h3>
            <p>Тент, реф, самосвал — статус каждой машины на карте.</p>
          </li>
          <li>
            <h3>Назначение</h3>
            <p>Водитель получает рейс сразу после вашего подтверждения.</p>
          </li>
        </ul>
      </section>

      <section className="land-section" id="drivers">
        <p className="kicker">Водитель</p>
        <h2 className="land-h">Рейс от погрузки до сдачи</h2>
        <p className="lede land-section-lede">
          Водителю не нужно собирать маршрут по звонкам. В кабинете — точка погрузки, груз, статус и следующий шаг по рейсу.
        </p>
        <ul className="land-facts">
          <li>
            <h3>Назначение</h3>
            <p>Новый рейс появляется в кабинете, как только перевозчик его закрепил.</p>
          </li>
          <li>
            <h3>На линии</h3>
            <p>Погрузка, в пути, прибытие — статусы без бумажных отметок.</p>
          </li>
          <li>
            <h3>Завершение</h3>
            <p>После выгрузки рейс закрывается, история остаётся в профиле.</p>
          </li>
        </ul>
      </section>

      <section className="land-section" id="how">
        <p className="kicker">Как это работает</p>
        <h2 className="land-h">От заявки до доставки</h2>
        <ol className="land-steps">
          <li>
            <b>01</b>
            <h3>Заявка</h3>
            <p>Отправитель создаёт заявку.</p>
          </li>
          <li>
            <b>02</b>
            <h3>Перевозчик</h3>
            <p>Перевозчик принимает заказ.</p>
          </li>
          <li>
            <b>03</b>
            <h3>Водитель</h3>
            <p>Водитель едет на погрузку.</p>
          </li>
          <li>
            <b>04</b>
            <h3>Доставка</h3>
            <p>Груз сдан, рейс завершён.</p>
          </li>
        </ol>
      </section>

      <section className="land-motion" id="region">
        <div className="land-motion-head">
          <div>
            <p className="kicker">Регион</p>
            <h2 className="land-h">Мангистау в движении</h2>
            <p className="lede">Актау → Шетпе → Жанаозен → Бейнеу</p>
          </div>
          <div className="land-kpis">
            <div>
              <b>12</b>
              <span>активных рейсов</span>
            </div>
            <div>
              <b>37</b>
              <span>заявок</span>
            </div>
            <div>
              <b>84</b>
              <span>перевозчика</span>
            </div>
            <div>
              <b>126</b>
              <span>автомобилей</span>
            </div>
          </div>
        </div>
      </section>
      <footer className="land-foot">Caspian LogHub · Мангистау</footer>
    </div>
  );
}
