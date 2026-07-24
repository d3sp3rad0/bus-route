const input = document.querySelector("#route-input");
const micButton = document.querySelector("#mic-button");
const parseButton = document.querySelector("#parse-button");
const sampleButton = document.querySelector("#sample-button");
const clearButton = document.querySelector("#clear-button");
const pointsList = document.querySelector("#points-list");
const pointsCount = document.querySelector("#points-count");
const openRoute = document.querySelector("#open-route");
const copyLink = document.querySelector("#copy-link");
const addPointForm = document.querySelector("#add-point-form");
const newPointInput = document.querySelector("#new-point");
const speechStatus = document.querySelector("#speech-status");
const historySection = document.querySelector("#history-section");
const historyList = document.querySelector("#history-list");
const clearHistory = document.querySelector("#clear-history");
const routeNote = document.querySelector("#route-note");

const SAMPLE_ROUTE = "Курск. Россошь. Волгоград. Мамаев курган. Обратно в Курск.";
const HISTORY_KEY = "bus-route-history-v1";
const GEOCODE_CACHE_KEY = "bus-route-geocode-cache-v2";
const GEOCODER_URL = "https://nominatim.openstreetmap.org/search";
const GEOCODE_DELAY_MS = 1100;
const CITY_RESULT_TYPES = new Set(["city", "town", "village", "hamlet", "municipality"]);
const MULTI_WORD_PLACE_STARTS = new Set([
  "белая",
  "великие",
  "великий",
  "верхний",
  "красная",
  "минеральные",
  "набережные",
  "нижний",
  "новая",
  "новый",
  "сергиев",
  "старая",
  "старый",
]);
const MULTI_WORD_PLACE_CONNECTORS = new Set(["на", "над", "под"]);
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const KURSK_NAMES = ["курск"];
const BELARUS_NAMES = [
  "беларусь",
  "белоруссия",
  "минск",
  "могилёв",
  "могилев",
  "гомель",
  "витебск",
  "брест",
  "гродно",
  "бобруйск",
  "полоцк",
  "новополоцк",
  "лида",
  "барановичи",
  "пинск",
  "орша",
];
const NORTH_BELARUS_CORRIDOR = ["Орёл", "Брянск"];

let points = [];
let recognition = null;
let isRecording = false;
let routeWasAdjusted = false;
let isPreparingRoute = false;
let lastGeocodeAt = 0;

function normalizePoint(value) {
  return value
    .replace(/[«»"]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(из|от|до|в|во|на|к|ко)\s+/i, "")
    .replace(/^(потом|затем|дальше|после этого)\s+/i, "")
    .trim();
}

function splitByCapitalizedPlaces(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const result = [];
  let current = "";

  words.forEach((word) => {
    const cleanWord = word.replace(/^[,.;:!?]+|[,.;:!?]+$/g, "");
    if (!cleanWord) {
      return;
    }

    const startsNewPoint = /^[А-ЯЁA-Z]/.test(cleanWord) && current && !shouldJoinPlaceWord(current);
    if (startsNewPoint) {
      result.push(current);
      current = cleanWord;
      return;
    }

    current = current ? `${current} ${cleanWord}` : cleanWord;
  });

  if (current) {
    result.push(current);
  }

  return result;
}

function shouldJoinPlaceWord(current) {
  const words = lookupKey(current).split(" ").filter(Boolean);
  const lastWord = words[words.length - 1];
  return MULTI_WORD_PLACE_STARTS.has(lastWord) || MULTI_WORD_PLACE_CONNECTORS.has(lastWord);
}

function splitSingleChunk(chunk) {
  const normalized = normalizePoint(chunk);
  if (!normalized) {
    return [];
  }

  const capitalized = splitByCapitalizedPlaces(normalized);
  if (capitalized.length > 1) {
    return capitalized;
  }

  return [normalized];
}

function parseRouteText(text) {
  const prepared = text
    .replace(/(^|\s)(обратно|назад|вернуться|возвращаемся|возвращение)\s+(в|во|на|к|ко)\s+/gi, ", ")
    .replace(/(^|\s)(потом|затем|дальше|после этого|далее|через)(?=\s|$)/gi, ",")
    .replace(/\s+(и потом|и затем)\s+/gi, ",")
    .replace(/[;:\n]+/g, ",")
    .replace(/[.]+/g, ",");

  const parsed = prepared
    .split(",")
    .flatMap(splitSingleChunk)
    .map(normalizePoint)
    .filter((point) => point.length > 1);

  return parsed.filter((point, index) => {
    const previous = parsed[index - 1];
    return !previous || previous.toLocaleLowerCase("ru-RU") !== point.toLocaleLowerCase("ru-RU");
  });
}

function pointMatches(point, names) {
  const normalized = point.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  return names.some((name) => normalized.includes(name.replace(/ё/g, "е")));
}

function lookupKey(point) {
  return point
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[.,;:!?()]/g, " ")
    .replace(/\b(город|г)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isKursk(point) {
  return pointMatches(point, KURSK_NAMES);
}

function isBelarusPoint(point) {
  return pointMatches(point, BELARUS_NAMES);
}

function appendIfUseful(target, point) {
  const previous = target[target.length - 1];
  if (!previous || previous.toLocaleLowerCase("ru-RU") !== point.toLocaleLowerCase("ru-RU")) {
    target.push(point);
  }
}

function corridorBetween(from, to) {
  if (isKursk(from) && isBelarusPoint(to)) {
    return NORTH_BELARUS_CORRIDOR;
  }

  if (isBelarusPoint(from) && isKursk(to)) {
    return [...NORTH_BELARUS_CORRIDOR].reverse();
  }

  return [];
}

function addSafetyWaypoints(routePoints) {
  if (routePoints.length < 2) {
    return { points: routePoints, adjusted: false };
  }

  const adjusted = [];
  let changed = false;

  routePoints.forEach((point, index) => {
    appendIfUseful(adjusted, point);
    const next = routePoints[index + 1];
    if (!next) {
      return;
    }

    const corridor = corridorBetween(point, next);
    corridor.forEach((waypoint) => {
      if (!pointMatches(point, [waypoint]) && !pointMatches(next, [waypoint])) {
        appendIfUseful(adjusted, waypoint);
        changed = true;
      }
    });
  });

  return { points: adjusted, adjusted: changed };
}

function loadGeocodeCache() {
  try {
    return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveGeocodeCache(cache) {
  localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function respectGeocoderLimit() {
  const elapsed = Date.now() - lastGeocodeAt;
  if (elapsed > 0 && elapsed < GEOCODE_DELAY_MS) {
    await wait(GEOCODE_DELAY_MS - elapsed);
  }
  lastGeocodeAt = Date.now();
}

async function geocodePoint(point) {
  const key = lookupKey(point);
  const cache = loadGeocodeCache();
  if (cache[key]) {
    return cache[key];
  }

  await respectGeocoderLimit();

  const params = new URLSearchParams({
    addressdetails: "1",
    format: "jsonv2",
    q: point,
    limit: "5",
    "accept-language": "ru",
  });

  const response = await fetch(`${GEOCODER_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error("Сервис поиска координат сейчас не ответил. Попробуйте еще раз.");
  }

  const results = await response.json();
  const first = pickBestGeocodeResult(results);
  if (!first || !first.lat || !first.lon) {
    throw new Error(`Не удалось найти точку: ${point}`);
  }

  const coordinates = {
    lat: Number(first.lat),
    lon: Number(first.lon),
  };
  cache[key] = coordinates;
  saveGeocodeCache(cache);
  return coordinates;
}

function pickBestGeocodeResult(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const scored = results.map((result, index) => ({
    result,
    score: scoreGeocodeResult(result) - index,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].result;
}

function scoreGeocodeResult(result) {
  let score = 0;
  if (result.category === "place") {
    score += 40;
  }
  if (CITY_RESULT_TYPES.has(result.type)) {
    score += 40;
  }
  if (CITY_RESULT_TYPES.has(result.addresstype)) {
    score += 30;
  }
  if (result.category === "boundary") {
    score -= 30;
  }
  return score;
}

async function buildYandexUrl(routePoints) {
  const coordinates = [];
  for (const point of routePoints) {
    coordinates.push(await geocodePoint(point));
  }

  const rtext = coordinates
    .map(({ lat, lon }) => `${lat.toFixed(6)},${lon.toFixed(6)}`)
    .join("~");
  return `https://yandex.ru/maps/?mode=routes&rtext=${rtext}&rtt=auto`;
}

function setRoutePreparing(preparing) {
  isPreparingRoute = preparing;
  render();
  speechStatus.textContent = preparing ? "Ищу точки" : "Готов";
}

async function prepareRouteUrl(routePoints) {
  if (routePoints.length < 2 || isPreparingRoute) {
    return null;
  }

  setRoutePreparing(true);
  try {
    const url = await buildYandexUrl(routePoints);
    saveHistory(routePoints, url);
    return url;
  } finally {
    setRoutePreparing(false);
  }
}

async function openPreparedRoute(routePoints) {
  try {
    const url = await prepareRouteUrl(routePoints);
    if (url) {
      window.location.href = url;
    }
  } catch (error) {
    window.alert(error.message || "Не удалось подготовить маршрут.");
  }
}

function updateInputFromPoints() {
  input.value = points.join(". ");
}

function saveHistory(routePoints, url) {
  if (routePoints.length < 2) {
    return;
  }

  const history = loadHistory().filter((item) => item.url !== url);
  history.unshift({
    points: routePoints,
    url,
    createdAt: new Date().toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 5)));
  renderHistory();
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function renderHistory() {
  const history = loadHistory();
  historySection.hidden = history.length === 0;
  historyList.innerHTML = "";

  history.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-card";
    button.innerHTML = `
      <strong>${escapeHtml(item.points[0])} → ${escapeHtml(item.points[item.points.length - 1])}</strong>
      <span>${escapeHtml(item.points.join(" • "))}</span>
    `;
    button.addEventListener("click", () => {
      points = [...item.points];
      updateInputFromPoints();
      render();
      openPreparedRoute(points);
    });
    historyList.append(button);
  });
}

function render() {
  pointsList.innerHTML = "";
  pointsCount.textContent = String(points.length);
  routeNote.hidden = !routeWasAdjusted;
  routeNote.textContent = routeWasAdjusted
    ? "Для маршрута Курск ↔ Беларусь добавлен северный коридор через Орёл и Брянск, чтобы Яндекс не вел вдоль границы с Украиной."
    : "";

  points.forEach((point, index) => {
    const item = document.createElement("li");
    item.className = "point-item";

    const number = document.createElement("span");
    number.className = "point-index";
    number.textContent = String(index + 1);

    const name = document.createElement("input");
    name.className = "point-name";
    name.value = point;
    name.setAttribute("aria-label", `Точка ${index + 1}`);
    name.addEventListener("change", () => {
      points[index] = normalizePoint(name.value);
      points = points.filter(Boolean);
      updateInputFromPoints();
      render();
    });

    const controls = document.createElement("div");
    controls.className = "point-controls";
    controls.append(
      pointButton("↑", "Выше", () => movePoint(index, -1), index === 0),
      pointButton("↓", "Ниже", () => movePoint(index, 1), index === points.length - 1),
      pointButton("×", "Удалить", () => removePoint(index), false, "delete"),
    );

    item.append(number, name, controls);
    pointsList.append(item);
  });

  const ready = points.length >= 2 && !isPreparingRoute;
  openRoute.classList.toggle("disabled", !ready);
  copyLink.disabled = !ready;
  openRoute.textContent = isPreparingRoute ? "Готовлю маршрут..." : "Открыть в Яндекс Картах";

  if (ready) {
    openRoute.href = "#";
    openRoute.onclick = (event) => {
      event.preventDefault();
      openPreparedRoute(points);
    };
  } else {
    openRoute.href = "#";
    openRoute.onclick = null;
  }
}

function pointButton(text, label, onClick, disabled, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `point-button ${className}`.trim();
  button.textContent = text;
  button.disabled = disabled;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function movePoint(index, direction) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= points.length) {
    return;
  }
  const moved = points[index];
  points[index] = points[nextIndex];
  points[nextIndex] = moved;
  updateInputFromPoints();
  render();
}

function removePoint(index) {
  points.splice(index, 1);
  updateInputFromPoints();
  render();
}

function applyRouteText(text, syncInput) {
  const parsedPoints = parseRouteText(text);
  const result = addSafetyWaypoints(parsedPoints);
  points = result.points;
  routeWasAdjusted = result.adjusted;
  if (syncInput) {
    updateInputFromPoints();
  }
  render();
}

function parseCurrentText() {
  applyRouteText(input.value, true);
}

function previewCurrentText() {
  applyRouteText(input.value, false);
}

async function copyCurrentLink() {
  if (points.length < 2 || isPreparingRoute) {
    return;
  }

  let url = "";
  try {
    url = await prepareRouteUrl(points);
    if (!url) {
      return;
    }

    await navigator.clipboard.writeText(url);
    copyLink.textContent = "Ссылка скопирована";
    window.setTimeout(() => {
      copyLink.textContent = "Скопировать ссылку";
    }, 1600);
  } catch (error) {
    if (url) {
      window.prompt("Скопируйте ссылку", url);
      return;
    }
    window.alert(error.message || "Не удалось подготовить ссылку.");
  }
}

function setupSpeech() {
  if (!SpeechRecognition) {
    micButton.disabled = true;
    micButton.title = "Используйте микрофон клавиатуры телефона";
    speechStatus.textContent = "Клавиатура";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "ru-RU";
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onstart = () => {
    isRecording = true;
    micButton.classList.add("recording");
    speechStatus.classList.add("recording");
    speechStatus.textContent = "Слушаю";
  };

  recognition.onresult = (event) => {
    let finalText = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      if (event.results[index].isFinal) {
        finalText += `${event.results[index][0].transcript} `;
      }
    }
    if (finalText.trim()) {
      input.value = `${input.value.trim()} ${finalText.trim()}`.trim();
      parseCurrentText();
    }
  };

  recognition.onerror = () => {
    stopSpeech();
    speechStatus.textContent = "Клавиатура";
  };

  recognition.onend = () => {
    stopSpeech();
  };
}

function toggleSpeech() {
  if (!recognition) {
    return;
  }
  if (isRecording) {
    recognition.stop();
  } else {
    recognition.start();
  }
}

function stopSpeech() {
  isRecording = false;
  micButton.classList.remove("recording");
  speechStatus.classList.remove("recording");
  speechStatus.textContent = "Готов";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

parseButton.addEventListener("click", parseCurrentText);
sampleButton.addEventListener("click", () => {
  input.value = SAMPLE_ROUTE;
  parseCurrentText();
});
clearButton.addEventListener("click", () => {
  input.value = "";
  points = [];
  routeWasAdjusted = false;
  render();
});
copyLink.addEventListener("click", copyCurrentLink);
micButton.addEventListener("click", toggleSpeech);
input.addEventListener("input", () => {
  window.clearTimeout(input.parseTimer);
  input.parseTimer = window.setTimeout(previewCurrentText, 350);
});
addPointForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const point = normalizePoint(newPointInput.value);
  if (!point) {
    return;
  }
  points.push(point);
  newPointInput.value = "";
  updateInputFromPoints();
  render();
});
clearHistory.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

setupSpeech();
render();
renderHistory();