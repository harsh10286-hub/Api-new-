const express = require("express");
const cloudscraper = require("cloudscraper");
const tough = require("tough-cookie");
const fs = require("fs");
const path = require("path");

const router = express.Router();

/* ================= CONFIG ================= */
const BASE_URL = "https://www.ivasms.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";

// Persistent cookie jar file (Railway volume)
const COOKIE_JAR_FILE = process.env.COOKIE_JAR_PATH || "/data/cookies.json";

// Global cookie jar (persists across requests)
let cookieJar = new tough.CookieJar();

// ---------- Your cookies (from browser) ----------
const MY_COOKIES = [
  {
    name: "XSRF-TOKEN",
    value: "eyJpdiI6IjJaSHh6SVA4WDV0NTRJbWZRRnFtQlE9PSIsInZhbHVlIjoiWnc0eGhjTWFFQTVsbkVyYkF4a3RESDU2WVRXYnVydFBiTDVvOVRPTHZCdEU4Rm1peTk3SGVFUHVpbE1mVGN5SXFsNFNPeEJoZklSYTNYd2VxR1djUjJYeExKUElKUSs2MFhaUE4zSnFXNnkyQkhYQUhCYTRVeDIvOGpjWVpBOGoiLCJtYWMiOiJmYWRjYzY5MDBjNmM4NmM3YWYzMWNlNDJlMDAyMGRhOGVjNDk4YzE1MWY5YzhlOWU4YjVkOTk3M2MyMjgyOTZhIiwidGFnIjoiIn0%3D",
    domain: "www.ivasms.com",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "lax"
  },
  {
    name: "ivas_sms_session",
    value: "eyJpdiI6IiszbjJjTGxpWkRESkJES1BacmhyRnc9PSIsInZhbHVlIjoiV2JkM2h6T1JmOFNlQVNsRzNDZEFIL2JpdUIxNC9JZ2hsZEc0SDZmcGJ1S2tGU241ZDVPQWwvUXVnSW9vZmttSWRtdmdCV1hycFF6WVQ5Ulh2am84MGl2MEQvNWxXdHBnckhtSURMUlprUVN2VElTTHQvN20wdjJyNzVOQWhUdkQiLCJtYWMiOiJhMDhmZDhiOTM0M2ExZTE1NTk5NmIwZDYwM2Q0MDY5ZDc2NjVmYTc5NDEzN2I0MTE1MjY4N2YyNzMwYWYwZTdhIiwidGFnIjoiIn0%3D",
    domain: "www.ivasms.com",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "lax"
  }
];

// ---------- Load / Save cookie jar to disk ----------
function loadCookieJar() {
  try {
    if (fs.existsSync(COOKIE_JAR_FILE)) {
      const serialized = fs.readFileSync(COOKIE_JAR_FILE, 'utf8');
      cookieJar = tough.CookieJar.fromJSON(serialized);
      console.log("[IVAS] Cookie jar loaded from disk");
    } else {
      console.log("[IVAS] No existing cookie jar, injecting your cookies");
      // Inject your cookies into the jar
      MY_COOKIES.forEach(cookieData => {
        const cookie = new tough.Cookie({
          key: cookieData.name,
          value: cookieData.value,
          domain: cookieData.domain,
          path: cookieData.path,
          httpOnly: cookieData.httpOnly,
          secure: cookieData.secure,
          sameSite: cookieData.sameSite === "lax" ? "lax" : (cookieData.sameSite === "strict" ? "strict" : "none")
        });
        cookieJar.setCookieSync(cookie, BASE_URL);
      });
      saveCookieJar(); // persist to disk for future runs
      console.log("[IVAS] Your cookies injected and saved");
    }
  } catch (err) {
    console.error("[IVAS] Failed to load cookie jar:", err.message);
  }
}

function saveCookieJar() {
  try {
    const dir = path.dirname(COOKIE_JAR_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(COOKIE_JAR_FILE, JSON.stringify(cookieJar.toJSON()), 'utf8');
    console.log("[IVAS] Cookie jar saved to disk");
  } catch (err) {
    console.error("[IVAS] Failed to save cookie jar:", err.message);
  }
}

// Call on startup
loadCookieJar();

// Helper to update cookie jar after cloudscraper request
function updateCookieJarFromResponse(response) {
  if (response && response.headers && response.headers['set-cookie']) {
    const setCookies = response.headers['set-cookie'];
    setCookies.forEach(cookieStr => {
      try {
        const cookie = tough.Cookie.parse(cookieStr);
        if (cookie) {
          cookieJar.setCookieSync(cookie, BASE_URL);
        }
      } catch (e) {}
    });
    saveCookieJar();
  }
}

/* ================= HTTP REQUEST using cloudscraper ================= */
async function makeRequest(method, path, body, contentType, extraHeaders = {}) {
  const url = BASE_URL + path;
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "en-PK,en;q=0.9",
    "Referer": `${BASE_URL}/portal`,
    ...extraHeaders
  };

  const options = {
    method: method,
    uri: url,
    headers: headers,
    jar: cookieJar,               // persists cookies across requests
    followRedirect: true,
    gzip: true,                   // auto decompress
    resolveWithFullResponse: true // to get headers for cookie updates
  };

  if (method === "POST" && body) {
    options.body = body;
    options.headers["Content-Type"] = contentType;
  }

  try {
    const response = await cloudscraper(options);
    // Update cookie jar from response headers
    updateCookieJarFromResponse(response);
    // Check for session expiration (Cloudflare success returns normal page)
    const bodyText = response.body;
    if (response.statusCode === 401 || response.statusCode === 419 ||
        bodyText.includes('"message":"Unauthenticated"') ||
        bodyText.includes('Ray ID') && bodyText.includes('cf-browser-verification')) {
      throw new Error("SESSION_EXPIRED");
    }
    return { status: response.statusCode, body: bodyText };
  } catch (err) {
    if (err.message === "SESSION_EXPIRED") throw err;
    // Cloudflare challenge page or other error
    if (err.message.includes("Cloudflare") || (err.response && err.response.body && err.response.body.includes("cf-browser-verification"))) {
      throw new Error("CLOUDFLARE_BLOCKED");
    }
    throw err;
  }
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

/* ================= FETCH _token FROM PORTAL ================= */
async function fetchToken() {
  const resp = await makeRequest("GET", "/portal", null, null, {
    "Accept": "text/html,application/xhtml+xml,*/*"
  });
  const match = resp.body.match(/name="_token"\s+value="([^"]+)"/) ||
                resp.body.match(/"csrf-token"\s+content="([^"]+)"/);
  return match ? match[1] : null;
}

/* ================= PARSE SMS MESSAGES ================= */
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

/* ================= GET NUMBERS ================= */
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

/* ================= GET SMS (multi-step) ================= */
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
        fix: "Check logs – may need fresh cookies or proxy"
      });
    }
    if (type === "numbers") return res.json(await getNumbers(token));
    if (type === "sms") return res.json(await getSMS(token));
    res.json({ error: "Invalid type. Use numbers or sms" });
  } catch (err) {
    if (err.message === "SESSION_EXPIRED") {
      return res.status(401).json({
        error: "Session expired — update cookies (Cloudflare may require fresh browser login)",
        fix: "Log into ivasms.com in a real browser, then restart this service (cookies will auto-save)"
      });
    }
    if (err.message === "CLOUDFLARE_BLOCKED") {
      return res.status(403).json({
        error: "Cloudflare is blocking this request",
        fix: "The site has enabled strong bot protection. Consider using a proxy service or headless browser."
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// Raw debug endpoint (optional, uses same makeRequest)
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
      { "Referer": `${BASE_URL}/portal/sms/received`, "Accept": "text/html, */*; q=0.01`, "User-Agent": ua }
    );
    res.set("Content-Type", "text/plain");
    res.send(`Range: ${range}\nNumber: ${number}\n\n` + r3.body.substring(0, 5000));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual cookie update endpoint – now just triggers a save (cloudscraper manages cookies automatically)
router.post("/update-session", express.json(), async (req, res) => {
  // Because cloudscraper uses its own jar, we can optionally force a fresh login by clearing jar and making a request.
  // But for simplicity, we'll just try to fetch token to validate.
  try {
    const token = await fetchToken();
    if (token) {
      return res.json({ success: true, message: "Session is active (cloudscraper auto-manages cookies)" });
    } else {
      return res.status(401).json({ error: "Still expired – try logging in from a real browser and restart this service" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status endpoint
router.get("/status", async (req, res) => {
  try {
    const token = await fetchToken();
    res.json({
      status: token ? "✅ Session active" : "❌ Session expired",
      hasToken: !!token,
      cookieJarFile: COOKIE_JAR_FILE,
      note: "Cloudscraper automatically manages cookies. If expired, visit ivasms.com in a real browser, then restart the service."
    });
  } catch (e) {
    res.json({ status: "❌ Session expired", error: e.message });
  }
});

module.exports = router;
