'use strict';
/**
 * 天气数据（Open-Meteo，免费、免密钥、无需注册）
 * 仅主进程使用：地理编码 + 5 日预报，带缓存与离线降级。
 *
 * 对外：getWeather(city) -> {
 *   city, resolvedName,
 *   current: { temp, feels, humidity, wind, code, desc, icon },
 *   daily:   [ { date, code, tmax, tmin, desc, icon } ] (含今天，共 5 天),
 *   cached, stale
 * }
 */

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FC_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟

const geoCache = new Map(); // 城市名 -> { lat, lon, resolved }
const fcCache = new Map(); // `${lat},${lon}` -> { data, expires }

// WMO 天气代码 -> 中文 + 图标
const WMO = {
  0: { t: '晴', icon: '☀️' },
  1: { t: '晴间多云', icon: '🌤' },
  2: { t: '部分多云', icon: '⛅' },
  3: { t: '阴', icon: '☁️' },
  45: { t: '雾', icon: '🌫' },
  48: { t: '雾凇', icon: '🌫' },
  51: { t: '小毛毛雨', icon: '🌦' },
  53: { t: '毛毛雨', icon: '🌦' },
  55: { t: '大毛毛雨', icon: '🌧' },
  56: { t: '冻毛毛雨', icon: '🌧' },
  57: { t: '冻毛毛雨', icon: '🌧' },
  61: { t: '小雨', icon: '🌧' },
  63: { t: '中雨', icon: '🌧' },
  65: { t: '大雨', icon: '🌧' },
  66: { t: '冻雨', icon: '🌧' },
  67: { t: '冻雨', icon: '🌧' },
  71: { t: '小雪', icon: '🌨' },
  73: { t: '中雪', icon: '🌨' },
  75: { t: '大雪', icon: '🌨' },
  77: { t: '雪粒', icon: '🌨' },
  80: { t: '阵雨', icon: '🌦' },
  81: { t: '阵雨', icon: '🌦' },
  82: { t: '强阵雨', icon: '🌦' },
  85: { t: '阵雪', icon: '🌨' },
  86: { t: '强阵雪', icon: '🌨' },
  95: { t: '雷阵雨', icon: '⛈' },
  96: { t: '雷阵雨伴冰雹', icon: '⛈' },
  99: { t: '强雷暴伴冰雹', icon: '⛈' },
};

function wmo(code) {
  return WMO[code] || { t: '未知', icon: '🌡' };
}

async function geocode(city) {
  const hit = geoCache.get(city);
  if (hit) return hit;
  const url = `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('地理编码请求失败');
  const j = await res.json();
  if (!j.results || !j.results.length) throw new Error('找不到这个城市：' + city);
  const g = j.results[0];
  const resolved = g.name + (g.admin1 && g.admin1 !== g.name ? '·' + g.admin1 : '') + (g.country ? '·' + g.country : '');
  const info = { lat: g.latitude, lon: g.longitude, resolved };
  geoCache.set(city, info);
  return info;
}

async function forecast(lat, lon) {
  const key = lat.toFixed(3) + ',' + lon.toFixed(3);
  const cached = fcCache.get(key);
  const now = Date.now();
  if (cached && cached.expires > now) return { data: cached.data, cached: true, stale: false };
  const url =
    `${FC_URL}?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
    `&timezone=auto&forecast_days=5&wind_speed_unit=ms`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('天气请求失败');
    const data = normalize(await res.json());
    fcCache.set(key, { data, expires: now + CACHE_TTL });
    return { data, cached: false, stale: false };
  } catch (err) {
    // 网络失败时，退回到已过期的缓存（若有），保证离线也有数据
    if (cached) return { data: cached.data, cached: true, stale: true };
    throw err;
  }
}

function normalize(j) {
  const cur = j.current || {};
  const daily = j.daily || {};
  const w = wmo(cur.weather_code);
  const times = daily.time || [];
  const codes = daily.weather_code || [];
  const maxs = daily.temperature_2m_max || [];
  const mins = daily.temperature_2m_min || [];
  const dailyArr = times.map((d, i) => {
    const dw = wmo(codes[i]);
    return {
      date: d,
      code: codes[i],
      tmax: maxs[i] != null ? Math.round(maxs[i]) : null,
      tmin: mins[i] != null ? Math.round(mins[i]) : null,
      desc: dw.t,
      icon: dw.icon,
    };
  });
  return {
    current: {
      temp: cur.temperature_2m != null ? Math.round(cur.temperature_2m) : null,
      feels: cur.apparent_temperature != null ? Math.round(cur.apparent_temperature) : null,
      humidity: cur.relative_humidity_2m != null ? Math.round(cur.relative_humidity_2m) : null,
      wind: cur.wind_speed_10m != null ? Math.round(cur.wind_speed_10m) : null,
      code: cur.weather_code,
      desc: w.t,
      icon: w.icon,
    },
    daily: dailyArr,
  };
}

async function getWeather(city) {
  const info = await geocode(city);
  const { data, cached, stale } = await forecast(info.lat, info.lon);
  return {
    city,
    resolvedName: info.resolved,
    current: data.current,
    daily: data.daily,
    cached,
    stale,
  };
}

module.exports = { getWeather };
