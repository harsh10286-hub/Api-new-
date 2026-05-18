const express = require("express");
const https   = require("https");
const zlib    = require("zlib");
const fs      = require("fs");
const path    = require("path");

const router = express.Router();

/* ================= CONFIG ================= */
const BASE_URL       = "https://www.ivasms.com";
const USER_AGENT     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";

// Persistent cookie file path (Railway volume)
const COOKIE_FILE = process.env.COOKIE_FILE_PATH || "/data/cookies.json";

// In-memory cookie object
let COOKIES = {};

// ---------- Load / Save cookies to disk ----------
function loadCookies() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const data = fs.readFileSync(COOKIE_FILE, 'utf8');
      COOKIES = JSON.parse(data);
      console.log("[IVAS] Cookies loaded from disk");
    } else {
      // Fallback to environment variables or hardcoded defaults
      COOKIES = {
        "XSRF-TOKEN":       process.env.INITIAL_XSRF_TOKEN || "eyJpdiI6InFEc3M1R2lmTFVRTmpnTmRPZno0cUE9PSIsInZhbHVlIjoiY29hazNndWJWcFlDNEJuTmVaSk9XN1Z0Wm93NnNhYnpSTENnVXljN080cDNpL0NXSUZYVUtTdVBTV3lnUXJxRmJDVjYzUXI3R0FtREMxVXBlUGZFaE03T1UzQkhqcHFwQ2xqUWtpMnhYRCtZb2pXT2dheG5xUE1HRzhaTW56TEYiLCJtYWMiOiJhODE1YTY4ODBjYmRhMzAwMWFjMmM1N2I0MjJiYjA2NjU3OGQ0NTg5NzAxYWU4MjcwODYwZWMzMTAyMDBkMGFiIiwidGFnIjoiIn0%3D",
        "ivas_sms_session": process.env.INITIAL_SESSION_COOKIE || "eyJpdiI6InAzWkxGdzU2WjhGbENqSDBLWDlVZ0E9PSIsInZhbHVlIjoiZnJEKzhLQUlhSzNLTDE4RzkzZm1ueGoxSllVQmRSN0xtYWljU3o5bEFmWXlnYmtNbDM1MGZTRmlrWTZsa2JOTXBIZkNVTHdiYVlpQ3Q1eDNraXFCWG1ITkVXK2QwK1hmTzdaeFBZcVVuVTZDaitVOUt5c2R4Qkc3OWt5NGh6VWgiLCJtYWMiOiI4M2JjYWQwOWM5ZmMyN2RkYTkyZjA5NjcxMGYyZWZiMDgzZjc3YThhNTg0MjlkMTUxOTQ2ZTQ1MGYwNzE1OGE0IiwidGFnIjoiIn0%3D"
      };
      console.log("[IVAS] Using fallback cookies (env or hardcoded)");
      saveCookies(); // create file for future runs
    }
  } catch (err) {
    console.error("[IVAS] Failed to load cookies:", err.message);
  }
}

function saveCookies() {
  try {
    // Ensure directory exists
    const dir = path.dirname(COOKIE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(COOKIES, null, 2), 'utf8');
    console.log("[IVAS] Cookies saved to disk");
  } catch (err) {
    console.error("[IVAS] Failed to save cookies:", err.message);
  }
}

// Call on startup
loadCookies();

// Helper to update cookies (both memory + disk)
function updateCookie(key, value) {
  if (key === "XSRF-TOKEN" || key === "ivas_sms_session") {
    COOKIES[key] = value;
    saveCookies();
  }
}

/* ================= HELPERS ================= */
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function cookieString() {
  return Object.entries(COOKIES).map(([k,v]) => `${k}=${v}`).join("; ");
}

function getXsrf() {
  try { return decodeURIComponent(COOKIES["XSRF-TOKEN"] || ""); }
  catch { return COOKIES["XSRF-TOKEN"] || ""; }
}

function safeJSON(text) {
  try { return JSON.parse(text); }
  catch { return { error: "Invalid JSON", preview: text.substring(0, 300) }; }
}

/* ================= HTTP REQUEST ================= */
function makeRequest(method, path, body, contentType, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent":       USER_AGENT,
      "Accept":           "*/*",
      "Accept-Encoding":  "gzip, deflate, br",
      "Accept-Language":  "en-PK,en;q=0.9",
      "Cookie":           cookieString(),
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN":     getXsrf(),
      "X-CSRF-TOKEN":     getXsrf(),
      "Origin":           BASE_URL,
      "Referer":          `${BASE_URL}/portal`,
      ...extraHeaders
    };

    if (method === "POST" && body) {
      headers["Content-Type"]   = contentType;
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = https.request(BASE_URL + path, { method, headers }, res => {
      // Auto-update cookies from response (and persist)
      if (res.headers["set-cookie"]) {
        res.headers["set-cookie"].forEach(c => {
          const sc = c.split(";")[0];
          const ki = sc.indexOf("=");
          if (ki > -1) {
            const k = sc.substring(0, ki).trim();
            const v = sc.substring(ki + 1).trim();
            if (k === "XSRF-TOKEN" || k === "ivas_sms_session") {
              updateCookie(k, v);
            }
          }
        });
      }

      let chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        try {
          const enc = res.headers["content-encoding"];
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
        } catch {}

        const text = buf.toString("utf-8");

        if (res.statusCode === 401 || res.statusCode === 419 ||
            text.includes('"message":"Unauthenticated"')) {
          return reject(new Error("SESSION_EXPIRED"));
        }

        resolve({ status: res.statusCode, body: text });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ================= FETCH _token FROM PORTAL ================= */
async function fetchToken() {
  const resp = await makeRequest("GET", "/portal", null, null, {
    "Accept": "text/html,application/xhtml+xml,*/*"
  });
  const match = resp.body.match(/name="_token"\s+value="([^"]+)"/) ||
                resp.body.match(/"csrf-token"\s+content="([^"]+)"/);
  return match ? match[1] : null;
}

/* ================= PARSE HELPERS (unchanged) ================= */
function stripHTML(html) {
  return (html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function parseSMSMessages(html, range, number, date) {
  const rows  = [];
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
    const sender  = senderM ? senderM[1].trim() : "SMS";
    const msgM   = row.match(/class="msg-text"[^>]*>([\s\S]*?)<\/div>/i);
    const message = msgM ? clean(msgM[1]) : "";
    const timeM = row.match(/class="time-cell"[^>]*>\s*([0-9:]+)\s*</);
    const time  = timeM ? timeM[1].trim() : "00:00:00";
    if (message) {
      rows.push([
        `${date} ${time}`,
        range,
        number,
        sender,
        message,
        "$",
        0
      ]);
    }
  }
  return rows;
}

/* ================= GET NUMBERS ================= */
async function getNumbers(token) {
  const ts   = Date.now();
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
    "Referer":      `${BASE_URL}/portal/numbers`,
    "Accept":       "application/json, text/javascript, */*; q=0.01",
    "X-CSRF-TOKEN": token
  });

  const json = safeJSON(resp.body);
  if (!json || !json.data) return json;
  const aaData = json.data.map(row => [
    row.range  || "",
    "",
    String(row.Number || ""),
    "Weekly",
    ""
  ]);
  return {
    sEcho:              2,
    iTotalRecords:      String(json.recordsTotal || aaData.length),
    iTotalDisplayRecords: String(json.recordsFiltered || aaData.length),
    aaData
  };
}

/* ================= GET SMS ================= */
async function getSMS(token) {
  const today    = getToday();
  const boundary = "----WebKitFormBoundary6I2Js7TBhcJuwIqw";
  const ua       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\n${today}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${token}`,
    `--${boundary}--`
  ].join("\r\n");

  // Step 1: Get ranges
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
    sEcho:                1,
    iTotalRecords:        String(allRows.length),
    iTotalDisplayRecords: String(allRows.length),
    aaData:               allRows
  };
}

/* ================= ROUTES ================= */

// Main API
router.get("/", async (req, res) => {
  const { type } = req.query;
  if (!type) return res.json({ error: "Use ?type=numbers or ?type=sms" });

  try {
    const token = await fetchToken();
    if (!token) {
      return res.status(401).json({
        error: "Session expired",
        fix:   "POST /api/ivasms/update-session with xsrf and session cookies"
      });
    }
    if (type === "numbers") return res.json(await getNumbers(token));
    if (type === "sms")     return res.json(await getSMS(token));
    res.json({ error: "Invalid type. Use numbers or sms" });
  } catch (err) {
    if (err.message === "SESSION_EXPIRED") {
      return res.status(401).json({
        error: "Session expired — update cookies",
        fix:   "POST /api/ivasms/update-session with xsrf and session"
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// Raw debug endpoint (unchanged)
router.get("/raw-sms", async (req, res) => {
  try {
    const token    = await fetchToken();
    const today    = getToday();
    const ua       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update session endpoint (now persists to disk)
router.post("/update-session", express.json(), (req, res) => {
  const { xsrf, session } = req.body || {};
  if (!xsrf || !session) {
    return res.status(400).json({
      error: "Required: xsrf and session",
      example: { xsrf: "XSRF-TOKEN value", session: "ivas_sms_session value" }
    });
  }
  updateCookie("XSRF-TOKEN", xsrf);
  updateCookie("ivas_sms_session", session);
  console.log("✅ [IVAS] Cookies updated and saved to disk");
  res.json({ success: true, message: "Cookies updated and persisted!" });
});

// Check session status
router.get("/status", async (req, res) => {
  try {
    const token = await fetchToken();
    res.json({
      status:    token ? "✅ Session active" : "❌ Session expired",
      hasToken:  !!token,
      cookieKeys: Object.keys(COOKIES),
      storagePath: COOKIE_FILE
    });
  } catch (e) {
    res.json({ status: "❌ Session expired", error: e.message });
  }
});

module.exports = router;
