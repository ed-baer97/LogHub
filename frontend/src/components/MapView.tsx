import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PLACE_KIND_RU, VEHICLE_STATUS_RU } from "../lib/labels";
import { useTheme, type Theme } from "../theme";
import type { Settlement, Vehicle } from "../types";

function tilesFor(theme: Theme) {
  const layer = theme === "light" ? "light_all" : "dark_all";
  return [`https://a.basemaps.cartocdn.com/${layer}/{z}/{x}/{y}@2x.png`];
}

function mapStyle(theme: Theme): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: tilesFor(theme),
        tileSize: 256,
        attribution: "© OpenStreetMap © CARTO",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };
}

type RouteLine = { id: string; coords: number[][] };
export type NetworkDot = { id: string; lon: number; lat: number; tone: "idle" | "order" | "load" | "transit" };

export default function MapView({
  settlements,
  vehicles,
  routes = [],
  trail = [],
  networkDots = [],
  navPosition = "top-right",
  onPick,
  fitTo,
  fitMaxZoom = 11,
  center,
  zoom,
  legend = "fleet",
  mapTheme,
  showControls = true,
  className = "",
  locked = false,
}: {
  settlements: Settlement[];
  vehicles: Vehicle[];
  routes?: RouteLine[];
  trail?: number[][];
  networkDots?: NetworkDot[];
  navPosition?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  onPick?: (lat: number, lon: number) => void;
  fitTo?: number[][];
  fitMaxZoom?: number;
  center?: [number, number];
  zoom?: number;
  legend?: "fleet" | "places" | "network" | "none";
  mapTheme?: Theme;
  showControls?: boolean;
  className?: string;
  locked?: boolean;
}) {
  const { theme } = useTheme();
  const effectiveTheme = mapTheme ?? theme;
  const themeRef = useRef(effectiveTheme);
  themeRef.current = effectiveTheme;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const viewRef = useRef({ center, zoom });
  viewRef.current = { center, zoom };
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const popup = useRef<maplibregl.Popup | null>(null);
  const ready = useRef(false);
  const appliedTheme = useRef<Theme | null>(null);
  const routesRef = useRef(routes);
  const trailRef = useRef(trail);
  const dotsRef = useRef(networkDots);
  routesRef.current = routes;
  trailRef.current = trail;
  dotsRef.current = networkDots;

  function applyOverlays(map: maplibregl.Map) {
    const routeSrc = map.getSource("routes") as GeoJSONSource | undefined;
    if (routeSrc) {
      routeSrc.setData({
        type: "FeatureCollection",
        features: routesRef.current
          .filter((r) => r.coords.length > 1)
          .map((r) => ({
            type: "Feature" as const,
            properties: { id: r.id },
            geometry: { type: "LineString" as const, coordinates: r.coords },
          })),
      });
    }
    const trailSrc = map.getSource("trail") as GeoJSONSource | undefined;
    if (trailSrc) {
      trailSrc.setData({
        type: "FeatureCollection",
        features:
          trailRef.current.length > 1
            ? [
                {
                  type: "Feature" as const,
                  properties: {},
                  geometry: { type: "LineString" as const, coordinates: trailRef.current },
                },
              ]
            : [],
      });
    }
    const dotsSrc = map.getSource("network") as GeoJSONSource | undefined;
    if (dotsSrc) {
      dotsSrc.setData({
        type: "FeatureCollection",
        features: dotsRef.current.map((d) => ({
          type: "Feature" as const,
          properties: { id: d.id, tone: d.tone },
          geometry: { type: "Point" as const, coordinates: [d.lon, d.lat] },
        })),
      });
    }
  }

  function addOverlayLayers(map: maplibregl.Map) {
    if (map.getSource("routes")) return;
    map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "routes-line",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#2ec4b6", "line-width": 2.2, "line-opacity": 0.78 },
    });
    map.addSource("trail", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "trail-line",
      type: "line",
      source: "trail",
      paint: {
        "line-color": "#e0a45a",
        "line-width": 2.5,
        "line-opacity": 0.9,
        "line-dasharray": [1.4, 1.2],
      },
    });
    map.addSource("network", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "network-glow",
      type: "circle",
      source: "network",
      paint: {
        "circle-radius": 11,
        "circle-blur": 0.8,
        "circle-opacity": 0.28,
        "circle-color": [
          "match",
          ["get", "tone"],
          "idle",
          "#3dcc7a",
          "order",
          "#6ec8ff",
          "load",
          "#e0a45a",
          "transit",
          "#a78bfa",
          "#2ec4b6",
        ],
      },
    });
    map.addLayer({
      id: "network-dots",
      type: "circle",
      source: "network",
      paint: {
        "circle-radius": 5,
        "circle-opacity": 0.95,
        "circle-stroke-width": 1,
        "circle-stroke-color": "rgba(255,255,255,0.35)",
        "circle-color": [
          "match",
          ["get", "tone"],
          "idle",
          "#3dcc7a",
          "order",
          "#6ec8ff",
          "load",
          "#e0a45a",
          "transit",
          "#a78bfa",
          "#2ec4b6",
        ],
      },
    });
  }

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const lock = lockedRef.current;
    const map = new maplibregl.Map({
      container: ref.current,
      style: mapStyle(themeRef.current),
      center: viewRef.current.center ?? [52.4, 44.0],
      zoom: viewRef.current.zoom ?? 6.2,
      minZoom: lock ? 6.1 : 1,
      maxZoom: lock ? 8.4 : 18,
      maxBounds: lock ? [[49.9, 42.3], [56.4, 46.2]] : undefined,
      attributionControl: { compact: true },
      scrollZoom: !lock,
      boxZoom: !lock,
      dragRotate: !lock,
      dragPan: !lock,
      keyboard: !lock,
      doubleClickZoom: !lock,
      touchZoomRotate: !lock,
      touchPitch: false,
    });
    popup.current = new maplibregl.Popup({ offset: 16, closeButton: true, maxWidth: "260px" });
    if (showControls) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), navPosition);
    map.on("load", () => {
      addOverlayLayers(map);
      ready.current = true;
      applyOverlays(map);
    });
    map.on("click", (e) => {
      pickRef.current?.(e.lngLat.lat, e.lngLat.lng);
    });
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(map.getContainer());
    return () => {
      ro.disconnect();
      popup.current?.remove();
      map.remove();
      mapRef.current = null;
      ready.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const pop = popup.current;
    if (!map) return;
    markers.current.forEach((m) => m.remove());
    markers.current = [];

    for (const s of settlements) {
      const el = document.createElement("div");
      el.className = `place-dot ${s.kind}`;
      el.title = s.name;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pop
          ?.setLngLat([s.lon, s.lat])
          .setHTML(
            `<strong>${s.name}</strong><br/>${PLACE_KIND_RU[s.kind] ?? s.kind}` +
              (s.population ? `<br/>население ${s.population.toLocaleString("ru-KZ")}` : "") +
              (s.note ? `<br/>${s.note}` : "")
          )
          .addTo(map);
      });
      markers.current.push(new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(map));
    }

    for (const v of vehicles) {
      const wrap = document.createElement("div");
      wrap.className = "truck-wrap";
      const mark = document.createElement("div");
      mark.className = `truck-mark${v.live ? " live" : ""}`;
      mark.style.setProperty("--h", `${v.heading}deg`);
      const label = document.createElement("span");
      label.className = "truck-label";
      label.textContent = v.plate;
      wrap.append(mark, label);
      wrap.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const st = v.live ? "live GPS" : (VEHICLE_STATUS_RU[v.status] ?? v.status);
        pop
          ?.setLngLat([v.lon, v.lat])
          .setHTML(
            `<strong>${v.plate}</strong><br/>${v.driver_name}<br/>${st}` +
              (v.current_order_id ? `<br/>заявка #${v.current_order_id}` : "<br/>без груза")
          )
          .addTo(map);
      });
      markers.current.push(
        new maplibregl.Marker({ element: wrap, anchor: "center" }).setLngLat([v.lon, v.lat]).addTo(map)
      );
    }
  }, [settlements, vehicles, className]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    applyOverlays(map);
  }, [routes, trail, networkDots]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    if (center && center.length >= 2) {
      map.jumpTo({ center: [center[0], center[1]], zoom: zoom ?? map.getZoom() });
      return;
    }
    if (!fitTo?.length) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const pt of fitTo) {
      if (pt.length >= 2) bounds.extend([pt[0], pt[1]]);
    }
    if (bounds.isEmpty()) return;
    map.fitBounds(bounds, { padding: 72, maxZoom: fitMaxZoom, duration: 700 });
  }, [center, zoom, fitTo, fitMaxZoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (appliedTheme.current === effectiveTheme) return;
    const first = appliedTheme.current === null;
    appliedTheme.current = effectiveTheme;
    if (first) return;

    ready.current = false;
    map.setStyle(mapStyle(effectiveTheme));
    map.once("style.load", () => {
      addOverlayLayers(map);
      ready.current = true;
      applyOverlays(map);
      map.resize();
    });
  }, [effectiveTheme]);

  return (
    <div className={`map-wrap${onPick ? " pick-mode" : ""}${className ? ` ${className}` : ""}`}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      {legend !== "none" ? (
      <div className="legend">
        {legend === "network" ? (
          <>
            <div>
              <i style={{ background: "#3dcc7a" }} />
              свободны
            </div>
            <div>
              <i style={{ background: "#6ec8ff" }} />
              заявки
            </div>
            <div>
              <i style={{ background: "#e0a45a" }} />
              погрузка
            </div>
            <div>
              <i style={{ background: "#a78bfa" }} />
              в пути
            </div>
          </>
        ) : (
          <>
            <div>
              <i style={{ background: "#2ec4b6" }} />
              город
            </div>
            <div>
              <i style={{ background: "#cfe7d8" }} />
              посёлок
            </div>
            <div>
              <i style={{ background: "#e07a5f" }} />
              промзона
            </div>
            {legend === "places" ? (
              <div>
                <i style={{ background: "#e0a45a" }} />
                стройка
              </div>
            ) : (
              <>
                <div>
                  <i style={{ background: "#e0a45a" }} />
                  машина / трек
                </div>
                <div>
                  <i style={{ background: "#2ec4b6" }} />
                  live GPS
                </div>
              </>
            )}
          </>
        )}
      </div>
      ) : null}
    </div>
  );
}
