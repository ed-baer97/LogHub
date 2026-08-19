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

export default function MapView({
  settlements,
  vehicles,
  routes = [],
  trail = [],
  navPosition = "top-right",
  onPick,
  fitTo,
}: {
  settlements: Settlement[];
  vehicles: Vehicle[];
  routes?: RouteLine[];
  trail?: number[][];
  navPosition?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  onPick?: (lat: number, lon: number) => void;
  fitTo?: number[][];
}) {
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const popup = useRef<maplibregl.Popup | null>(null);
  const ready = useRef(false);
  const routesRef = useRef(routes);
  const trailRef = useRef(trail);
  routesRef.current = routes;
  trailRef.current = trail;

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
  }

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: mapStyle(themeRef.current),
      center: [52.4, 44.0],
      zoom: 6.2,
      attributionControl: true,
    });
    popup.current = new maplibregl.Popup({ offset: 16, closeButton: true, maxWidth: "260px" });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), navPosition);
    map.on("load", () => {
      map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "routes-line",
        type: "line",
        source: "routes",
        paint: { "line-color": "#2ec4b6", "line-width": 3, "line-opacity": 0.85 },
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
  }, [settlements, vehicles]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    applyOverlays(map);
  }, [routes, trail]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current || !fitTo?.length) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const pt of fitTo) {
      if (pt.length >= 2) bounds.extend([pt[0], pt[1]]);
    }
    if (bounds.isEmpty()) return;
    map.fitBounds(bounds, { padding: 72, maxZoom: 11, duration: 700 });
  }, [fitTo]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("osm") as maplibregl.RasterTileSource | undefined;
      src?.setTiles(tilesFor(theme));
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [theme]);

  return (
    <div className={`map-wrap${onPick ? " pick-mode" : ""}`}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      <div className="legend">
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
        <div>
          <i style={{ background: "#e0a45a" }} />
          машина / трек
        </div>
        <div>
          <i style={{ background: "#2ec4b6" }} />
          live GPS
        </div>
      </div>
    </div>
  );
}
