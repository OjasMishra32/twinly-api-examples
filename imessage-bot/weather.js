// The weather lookup behind "@twinly weather <city>".
//
// By default it makes up a forecast from the city's name (same city, same
// answer), so the bot works offline and its tests never touch the internet.
// Set WEATHER_SOURCE=open-meteo for real weather from Open-Meteo's free API,
// which needs no key.

import crypto from "node:crypto";

export async function weather(city) {
  if (process.env.WEATHER_SOURCE === "open-meteo") return openMeteo(city);
  return sample(city);
}

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function sample(city) {
  const h = crypto.createHash("sha256").update(city.trim().toLowerCase()).digest();
  const tempF = 55 + (h[0] % 35);
  const sky = ["sunny", "partly cloudy", "cloudy", "light rain", "windy"][h[1] % 5];
  return `${titleCase(city.trim())}: ${tempF}°F and ${sky} (sample data)`;
}

const SKY = [
  [[0], "clear"], [[1, 2, 3], "partly cloudy"], [[45, 48], "foggy"], [[51, 53, 55, 56, 57], "drizzle"],
  [[61, 63, 65, 66, 67], "rain"], [[71, 73, 75, 77], "snow"], [[80, 81, 82], "showers"], [[95, 96, 99], "thunderstorms"],
];

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`weather service said HTTP ${res.status}`);
  return res.json();
}

async function openMeteo(city) {
  // "Gainesville, FL" or "Gainesville FL": search the town name.
  const names = [city.split(",")[0].trim()];
  if (names[0].includes(" ")) names.push(names[0].split(" ").slice(0, -1).join(" "));
  let place;
  for (const name of names) {
    const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(name)}`);
    place = geo.results?.[0];
    if (place) break;
  }
  if (!place) return `I couldn't find a place called "${city}".`;
  const wx = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph",
  );
  const c = wx.current;
  const sky = SKY.find(([codes]) => codes.includes(c.weather_code))?.[1] ?? "mixed";
  return `${place.name}${place.admin1 ? `, ${place.admin1}` : ""}: ${Math.round(c.temperature_2m)}°F, ${sky}, wind ${Math.round(c.wind_speed_10m)} mph`;
}
