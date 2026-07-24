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

const SAMPLE_ROUTE = "Курск. Россошь. Волгоград. Мамаев курган. Обратно в Курск.";
const HISTORY_KEY = "bus-route-history-v1";
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let points = [];
let recognition = null;
let isRecording = false;

function normalizePoint(value) {
  return value
    .replace(/[«»"]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(из|от|до|в|во|на|к|ко)\s+/i, "")
    .replace(/^(потом|затем|дальше|после этого)\s+/i, "")
    .trim();
}

function parseRouteText(text) {
  const prepared = text
    .replace(/\b(обратно|назад|вернуться|возвращаемся|возвращение)\s+(в|во|на|к|ко)\s+/gi, ", ")
    .replace(/\b(потом|затем|дальше|после этого|далее|через)\b/gi, ",")
    .replace(/\s+(и потом|и затем)\s+/gi, ",")
    .replace(/[;:\n]+/g, ",")
    .replace(/[.]+/g, ",");

  const parsed = prepared
    .split(",")
    .map(normalizePoint)
    .filter(Boolean)
    .filter((point) => point.length > 1);

  return parsed.filter((point, index) => {
    const previous = parsed[index - 1];
    return !previous || previous.toLocaleLowerCase("ru-RU") !== point.toLocaleLowerCase("ru-RU");
  });
}

function buildYandexUrl(routePoints) {
  const rtext = routePoints.map((point) => encodeURIComponent(point)).join("~");
  return `https://yandex.ru/maps/?mode=routes&rtext=${rtext}&rtt=auto`;
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
      window.location.href = item.url;
    });
    historyList.append(button);
  });
}

function render() {
  pointsList.innerHTML = "";
  pointsCount.textContent = String(points.length);

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

  const ready = points.length >= 2;
  openRoute.classList.toggle("disabled", !ready);
  copyLink.disabled = !ready;

  if (ready) {
    const url = buildYandexUrl(points);
    openRoute.href = url;
    openRoute.onclick = () => saveHistory(points, url);
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

function parseCurrentText() {
  points = parseRouteText(input.value);
  updateInputFromPoints();
  render();
}

function copyCurrentLink() {
  if (points.length < 2) {
    return;
  }
  const url = buildYandexUrl(points);
  navigator.clipboard
    .writeText(url)
    .then(() => {
      copyLink.textContent = "Ссылка скопирована";
      window.setTimeout(() => {
        copyLink.textContent = "Скопировать ссылку";
      }, 1600);
    })
    .catch(() => {
      window.prompt("Скопируйте ссылку", url);
    });
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
  render();
});
copyLink.addEventListener("click", copyCurrentLink);
micButton.addEventListener("click", toggleSpeech);
input.addEventListener("input", () => {
  window.clearTimeout(input.parseTimer);
  input.parseTimer = window.setTimeout(parseCurrentText, 350);
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

