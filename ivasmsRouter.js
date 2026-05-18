const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const router = express.Router();

/* ================= CONFIG ================= */
const BASE_URL = "https://www.ivasms.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";
const COOKIE_FILE = process.env.COOKIE_JAR_PATH || "/data/puppeteer_cookies.json";

// Your fresh cookies (extracted from browser)
const MY_COOKIES = [
  {
    name: "XSRF-TOKEN",
    value: "eyJpdiI6IisxeS9FSnBJNldQenlRMzNUNjNSQ0E9PSIsInZhbHVlIjoiOTZmR2I0OVRqaEhZb2JaNVU3OXpWdkN6RFhLL2xraTh2ZmxQU1poUmdZd0M0Y01vZWNyaTZFaGkrYjZWOWhyOFl3Zy9URng2dCtuKzZ0M29UeG9YM0VpdEJ6VTNFN0JnQ2U5YmhrVWxSRVp5UkZLRER4N2lqUlk3UFBHZGk0UnUiLCJtYWMiOiI3MzE4NDNlYTI5YzkwY2Q2NWFlMGY0MzUyYzBkZDg4MWQ4MjRmZDM5ODY5MWY3ZmNjYzZiZTZlZTVmZDM3M2MyIiwidGFnIjoiIn0%3D",
    domain: "www.ivasms.com",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "lax"
  },
  {
    name: "ivas_sms_session",
    value: "eyJpdiI6Imt4NWZ4WWxPV2FEcTlqNEpranFUc1E9PSIsInZhbHVlIjoiSkt5b00rb3l2OGc4STRiYUczbzZjWFhjWWE2YnZWNU9UODdGRXprSmhCMGtrM3Y4TVdzd1lNQnR2djdHVklaMVlmZDZ5WjJqSTVZV09uWHdhU1JxK0JGcTQwZVdFaDExT2pNZ2RUc1kzWVRreFk4SEV6Tk1sZ2tXVkladWx3Y0siLCJtYWMiOiI1NzdjYzkxMWI5NzUzM2I1NmMzOTU0YTFkZmM3Njg1NjU3NmMzNjk5ODE4ZTQ4MzMzZTMxY2Y3ZDQ5MGEyZmM5IiwidGFnIjoiIn0%3D",
    domain: "www.ivasms.com",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "lax"
  }
];

// Global browser and page
let browser = null;
let page = null;

// ---------- Browser initialisation ----------
async function getBrowserPage() {
  if (browser && page) return page;

  console.log("[IVAS] Launching Puppeteer browser...");
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu"
    ]
  });

  page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1280, height: 800 });

  // Load existing cookies from disk (if any)
  let loadedCookies = false;
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
      await page.setCookie(...cookies);
      console.log("[IVAS] Loaded cookies from disk");
      loadedCookies = true;
    } catch (err) {
      console.error("[IVAS] Failed to load cookies:", err.message);
    }
  }

  // Inject your fresh cookies (overwrites any old ones)
  for (const cookie of MY_COOKIES) {
    await page.setCookie(cookie);
  }
  console.log("[IVAS] Injected your fresh login cookies");

  // Save the combined cookie jar to disk
  await saveCookies(page);

  // Now navigate to portal – this will solve Cloudflare challenge if needed
  console.log("[IVAS] Navigating to portal (solving Cloudflare if necessary)...");
  await page.goto(BASE_URL + "/portal", { waitUntil: "networkidle2", timeout: 60000 });
  await saveCookies(page);
  console.log("[IVAS] Cloudflare challenge solved / portal loaded");

  return page;
}

async function saveCookies(page) {
  const cookies = await page.cookies();
  const dir = path.dirname(COOKIE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  console.log("[IVAS] Cookies saved to disk");
}

// ---------- HTTP request using Puppeteer ----------
async function makeRequest(method, path, body = null, contentType = null, extraHeaders = {}) {
  const url = BASE_URL + path;
  const page = await getBrowserPage();

  await page.setExtraHTTPHeaders({
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "en-PK,en;q=0.9",
    "Referer": `${BASE_URL}/portal`,
    ...extraHeaders
  });

  if (method === "GET") {
    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    const bodyText = await response.text();
    await saveCookies(page);
    return { status: response.status(), body: bodyText };
  }

  // POST request using page.evaluate
  const result = await page.evaluate(async (url, method, body, contentType, headers) => {
    const fetchOptions = {
      method,
      headers: { "Content-Type": contentType, ...headers },
      credentials: "include"
    };
    if (body) fetchOptions.body = body;
    const res = await fetch(url, fetchOptions);
    return {
      status: res.status,
      body: await res.text()
    };
  }, url, method, body, contentType, extraHeaders);

  await saveCookies(page);
  return result;
}

/* ================= HELPERS ================= */
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function safeJSON(text) {
  try { return JSON.parse(text); }
  catch { return { error: "Invalid JSON", preview: text.substring(0, 300) }; }
}

async function fetchToken() {
  const resp = await makeRequest("GET", "/portal", null, null, {
    "Accept": "text/html,application/xhtml+xml,*/*"
  });
  const match = resp.body.match(/name="_token"\s+value="([^"]+)"/) ||
                resp.body.match(/"csrf-token"\s+content="([^"]+)"/);
  return match ? match[1] : null;
}

function parseSMSMessages(html, range, number, date) {
  const rows = [];
  const clean = t => (t || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&#039;/g, "'")
    .replace(/\s+/g, " ").trim();

  const trAll = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const trM of trAll) {
    const row = trM[1];
    if (row.includes("<th")) continue;
    const senderM = row.match(/class="cli-tag"[^>]*>([^<]+)</);
    const sender = senderM ? senderM[1].trim() : "SMS";
    const msgM = row.match(/class="msg-text"[^>]*>([\s\S]*?)<\/div>/i);
    const message = msgM ? clean(msgM[1]) : "";
    const timeM = row.match(/class="time-cell"[^>]*>\s*([0-9:]+)\s*</);
    const time = timeM ? timeM[1].trim() : "00:00:00";
    if (message) {
      rows.push([`${date} ${time}`, range, number, sender, message, "$", 0]);
    }
  }
  return rows;
}

async function getNumbers(token) {
  const ts = Date.now();
  const path = `/portal/numbers?draw=1`
    + `&columns[0][data]=number_id&columns[0][name]=id&columns[0][orderable]=false`
    + `&columns[1][data]=Number`
    + `&columns[2][data]=range`
    + `&columns[3][data]=A2P`
    + `&columns[4][data]=LimitA2P`
    + `&columns[5][data]=limit_cli_a2p`
    + `&columns[6][data]=limit_cli_did_a2p`
    + `&columns[7][data]=action&columns[7][searchable]=false&columns[7][orderable]=false`
    + `&order[0][column]=1&order[0][dir]=desc`
    + `&start=0&length=5000&search[value]=&_=${ts}`;

  const resp = await makeRequest("GET", path, null, null, {
    "Referer": `${BASE_URL}/portal/numbers`,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-CSRF-TOKEN": token
  });

  const json = safeJSON(resp.body);
  if (!json || !json.data) return json;
  const aaData = json.data.map(row => [
    row.range || "",
    "",
    String(row.Number || ""),
    "Weekly",
    ""
  ]);
  return {
    sEcho: 2,
    iTotalRecords: String(json.recordsTotal || aaData.length),
    iTotalDisplayRecords: String(json.recordsFiltered || aaData.length),
    aaData
  };
}

async function getSMS(token) {
  const today = getToday();
  const boundary = "----WebKitFormBoundary6I2Js7TBhcJuwIqw";
  const ua = USER_AGENT;

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${token}`,
    `--${boundary}--`
  ].join("\r\n");

  const r1 = await makeRequest(
    "POST", "/portal/sms/received/getsms", parts,
    `multipart/form-data; boundary=${boundary}`,
    { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
  );

  const ranges = [...r1.body.matchAll(/toggleRange\('([^']+)'/g)].map(m => m[1]);
  console.log(`[IVAS] Ranges: ${ranges.join(", ")}`);

  const allRows = [];
  for (const range of ranges) {
    const b2 = new URLSearchParams({ _token: token, start: today, end: today, range }).toString();
    const r2 = await makeRequest(
      "POST", "/portal/sms/received/getsms/number", b2,
      "application/x-www-form-urlencoded",
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
    ).catch(() => null);
    if (!r2) continue;

    const numbers = [...r2.body.matchAll(/toggleNum[^(]+\('(\d+)'/g)].map(m => m[1]);
    console.log(`[IVAS] ${range} → numbers: ${numbers.join(", ")}`);

    for (const number of numbers) {
      const b3 = new URLSearchParams({ _token: token, start: today, end: today, Number: number, Range: range }).toString();
      const r3 = await makeRequest(
        "POST", "/portal/sms/received/getsms/number/sms", b3,
        "application/x-www-form-urlencoded",
        { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
      ).catch(() => null);
      if (!r3) continue;
      const msgs = parseSMSMessages(r3.body, range, number, today);
      allRows.push(...msgs);
    }
  }
  return {
    sEcho: 1,
    iTotalRecords: String(allRows.length),
    iTotalDisplayRecords: String(allRows.length),
    aaData: allRows
  };
}

/* ================= ROUTES ================= */
router.get("/", async (req, res) => {
  const { type } = req.query;
  if (!type) return res.json({ error: "Use ?type=numbers or ?type=sms" });

  try {
    const token = await fetchToken();
    if (!token) {
      return res.status(401).json({
        error: "Session expired or Cloudflare blocked",
        fix: "Check logs – may need fresh cookies"
      });
    }
    if (type === "numbers") return res.json(await getNumbers(token));
    if (type === "sms") return res.json(await getSMS(token));
    res.json({ error: "Invalid type. Use numbers or sms" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/raw-sms", async (req, res) => {
  try {
    const token = await fetchToken();
    const today = getToday();
    const ua = USER_AGENT;
    const boundary = "----WebKitFormBoundary6I2Js7TBhcJuwIqw";
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n${today}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n${today}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${token}`,
      `--${boundary}--`
    ].join("\r\n");
    const r1 = await makeRequest("POST", "/portal/sms/received/getsms", parts,
      `multipart/form-data; boundary=${boundary}`,
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
    );
    const rangeMatch = r1.body.match(/toggleRange\('([^']+)'/);
    if (!rangeMatch) return res.send("No ranges:\n" + r1.body.substring(0,1000));
    const range = rangeMatch[1];
    const r2 = await makeRequest("POST", "/portal/sms/received/getsms/number",
      new URLSearchParams({ _token: token, start: today, end: today, range }).toString(),
      "application/x-www-form-urlencoded",
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
    );
    const numMatch = r2.body.match(/toggleNum[^(]+\('(\d+)'/);
    if (!numMatch) return res.send(`Range: ${range}\nNo numbers:\n` + r2.body.substring(0,1000));
    const number = numMatch[1];
    const r3 = await makeRequest("POST", "/portal/sms/received/getsms/number/sms",
      new URLSearchParams({ _token: token, start: today, end: today, Number: number, Range: range }).toString(),
      "application/x-www-form-urlencoded",
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01", "User-Agent": ua }
    );
    res.set("Content-Type", "text/plain");
    res.send(`Range: ${range}\nNumber: ${number}\n\n` + r3.body.substring(0, 5000));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Force refresh: close browser, reopen, re‑solve Cloudflare
router.post("/update-session", express.json(), async (req, res) => {
  try {
    if (browser) await browser.close();
    browser = null;
    page = null;
    await getBrowserPage(); // will inject cookies and solve challenge
    const token = await fetchToken();
    if (token) {
      res.json({ success: true, message: "Session refreshed" });
    } else {
      res.status(401).json({ error: "Still expired – check cookies" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/status", async (req, res) => {
  try {
    const token = await fetchToken();
    res.json({
      status: token ? "✅ Session active" : "❌ Session expired",
      hasToken: !!token,
      cookieFile: COOKIE_FILE,
      note: "Puppeteer solves Cloudflare, your fresh cookies injected"
    });
  } catch (e) {
    res.json({ status: "❌ Session expired", error: e.message });
  }
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  if (browser) await browser.close();
  process.exit(0);
});

module.exports = router;
