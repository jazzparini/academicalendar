import { existsSync } from "node:fs";

if (existsSync(new URL("./.env", import.meta.url))) {
  process.loadEnvFile(new URL("./.env", import.meta.url));
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

for (const [name, value] of Object.entries({ NOTION_TOKEN, NOTION_DB_ID, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID })) {
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
}

const TIMEZONE = "America/Santiago";

const WINDOWS = [
  { checkbox: "Aviso 3d enviado", seconds: 3 * 24 * 3600, emoji: "🔔", label: "3 días" },
  { checkbox: "Aviso 1d enviado", seconds: 24 * 3600, emoji: "⏳", label: "1 día" },
  { checkbox: "Aviso urgente enviado", seconds: 3 * 3600, emoji: "🚨", label: "urgente" },
];

async function notionRequest(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Notion ${options.method ?? "GET"} ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function queryAllPages() {
  const pages = [];
  let cursor;
  do {
    const body = cursor ? { start_cursor: cursor } : {};
    const json = await notionRequest(`/databases/${NOTION_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    pages.push(...json.results);
    cursor = json.has_more ? json.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function setPageProperties(pageId, properties) {
  await notionRequest(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const params = new URLSearchParams({ chat_id: TELEGRAM_CHAT_ID, text });
  const res = await fetch(url, { method: "POST", body: params });
  if (!res.ok) {
    throw new Error(`Telegram sendMessage -> HTTP ${res.status}: ${await res.text()}`);
  }
}

function titleText(page, propName) {
  return (page.properties[propName]?.title ?? []).map((t) => t.plain_text).join("") || "(sin título)";
}

function selectName(page, propName) {
  return page.properties[propName]?.select?.name ?? null;
}

function checkboxValue(page, propName) {
  return page.properties[propName]?.checkbox === true;
}

function formatDeadlineLocal(isoDate) {
  return new Date(isoDate).toLocaleString("es-CL", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function localDateKey(isoDate) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(isoDate),
  );
}

async function run() {
  const now = new Date();
  const todayKey = localDateKey(now.toISOString());
  const pages = await queryAllPages();
  const sent = [];

  for (const page of pages) {
    const deadlineIso = page.properties["Fecha límite"]?.date?.start;
    const estado = selectName(page, "Estado");
    if (!deadlineIso || estado === "Entregada") continue;

    const deadline = new Date(deadlineIso);
    const secondsLeft = Math.floor((deadline.getTime() - now.getTime()) / 1000);
    const programa = selectName(page, "Programa") ?? "(programa desconocido)";
    const evaluacion = titleText(page, "Evaluación");
    const deadlineLabel = formatDeadlineLocal(deadlineIso);

    if (secondsLeft <= 0) {
      if (estado !== "Vencida") {
        await setPageProperties(page.id, { Estado: { select: { name: "Vencida" } } });
      }
      continue;
    }

    // Ventana "mismo día", evaluada de forma independiente de las de conteo regresivo.
    if (localDateKey(deadlineIso) === todayKey && !checkboxValue(page, "Aviso día enviado")) {
      const text = `📅 HOY vence: ${evaluacion} (${programa}) — ${deadlineLabel} (hora Chile)`;
      await sendTelegram(text);
      await setPageProperties(page.id, { "Aviso día enviado": { checkbox: true } });
      sent.push(text);
    }

    for (const w of WINDOWS) {
      if (secondsLeft <= w.seconds && !checkboxValue(page, w.checkbox)) {
        const text = `${w.emoji} Vence en ${w.label}: ${evaluacion} (${programa}) — ${deadlineLabel} (hora Chile)`;
        await sendTelegram(text);
        await setPageProperties(page.id, { [w.checkbox]: { checkbox: true } });
        sent.push(text);
      }
    }
  }

  console.log(sent.length ? sent.join("\n") : "Sin avisos pendientes.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
