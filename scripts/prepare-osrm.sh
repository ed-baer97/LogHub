#!/usr/bin/env bash
# Скачивает OSM Казахстана и готовит граф OSRM (MLD) в volume loghub_osrmdata.
# Первый прогон долгий (десятки минут, гигабайты RAM). Пока графа нет,
# контейнер osrm в Compose спит, API ходит в fallback по прямой.
set -euo pipefail
cd "$(dirname "$0")/.."

VOLUME="${OSRM_VOLUME:-loghub_osrmdata}"
IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v5.27.1}"
PBF_URL="${OSRM_PBF_URL:-https://download.geofabrik.de/asia/kazakhstan-latest.osm.pbf}"

docker volume create "$VOLUME" >/dev/null
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> Download Kazakhstan OSM extract"
if command -v curl >/dev/null 2>&1; then
  curl -L --fail --progress-bar -o "$WORKDIR/kazakhstan-latest.osm.pbf" "$PBF_URL"
else
  wget -O "$WORKDIR/kazakhstan-latest.osm.pbf" "$PBF_URL"
fi

echo "==> Copy PBF into Docker volume $VOLUME"
docker run --rm \
  -v "$VOLUME:/data" \
  -v "$WORKDIR:/src" \
  alpine:3.20 \
  sh -c "cp /src/kazakhstan-latest.osm.pbf /data/ && rm -f /data/kazakhstan-latest.osrm*"

echo "==> osrm-extract (долго)"
docker run --rm -v "$VOLUME:/data" "$IMAGE" osrm-extract -p /opt/car.lua /data/kazakhstan-latest.osm.pbf

echo "==> osrm-partition"
docker run --rm -v "$VOLUME:/data" "$IMAGE" osrm-partition /data/kazakhstan-latest.osrm

echo "==> osrm-customize"
docker run --rm -v "$VOLUME:/data" "$IMAGE" osrm-customize /data/kazakhstan-latest.osrm

echo "==> drop PBF from volume"
docker run --rm -v "$VOLUME:/data" alpine:3.20 rm -f /data/kazakhstan-latest.osm.pbf

echo
echo "Граф готов. Перезапустите маршрутизатор:"
echo "  docker compose up -d osrm"
echo
echo "Backend в Compose уже смотрит на http://osrm:5000 (OSRM_URL)."
