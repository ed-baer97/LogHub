export const STATUS_RU: Record<string, string> = {
  open: "открыта",
  taken: "взята перевозчиком",
  assigned: "борт назначен",
  arrived: "на погрузке",
  loading: "погрузка",
  pickup: "погрузка",
  transit: "в пути",
  delivered: "доставлена",
  cancelled: "отменена",
};

export const PLACE_KIND_RU: Record<string, string> = {
  city: "город",
  village: "посёлок",
  industrial: "промзона",
  construction: "стройка",
};

export const VEHICLE_STATUS_RU: Record<string, string> = {
  idle: "свободен",
  assigned: "назначен",
  enroute: "в рейсе",
  loading: "погрузка",
};

/** Подписи этапов для кабинета водителя — те же статусы заявки, другой тон. */
export const DRIVER_STAGE_RU: Record<string, string> = {
  assigned: "Ожидает погрузки",
  arrived: "На погрузке",
  loading: "Готов к выезду",
  transit: "В пути",
  delivered: "Рейс завершён",
};
