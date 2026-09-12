/**
 * Screenshots the running dev server and reports layout, typography and
 * backdrop measurements that a quick look at a screenshot cannot confirm.
 *
 * Usage: start `pnpm worker:dev`, then run `node scripts/verify-ui.mjs`.
 * Override the browser with CHROME_PATH if it lives somewhere else; images are
 * written to docs/screenshots/ui-review, deliberately outside `dist` because
 * `vite build` empties that directory.
 *
 * Privacy: the run enables the app's own "hide IP" switch before capturing, so
 * generated images never contain a real address.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const CHROME =
  process.env.CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
// Overridable because the dev server (or another tool) may already own the port.
const PORT = Number(process.env.DEBUG_PORT ?? 9444);
// Point APP_URL at a deployment to verify production instead of local dev.
const APP = process.env.APP_URL ?? "http://127.0.0.1:8787/";
// Not under dist/: `vite build` empties that directory.
const OUT = process.env.OUT_DIR ?? "docs/screenshots/ui-review";
// Outside the project: Vite watches the project tree, and Chrome keeps a lock
// on its profile's Cookies file, which makes the watcher crash with EBUSY.
const PROFILE = join(tmpdir(), "one-ip-chrome-profile");

mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function devtoolsTarget(attempts = 1) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`)
      ).json();
      const page = list.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  return null;
}

// Reuse a Chrome already listening on the debug port, otherwise start one.
let chrome = null;
if (!(await devtoolsTarget(1))) {
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--hide-scrollbars",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--window-size=1440,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
}
const target = await devtoolsTarget(60);
if (!target) throw new Error("devtools did not become ready");

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = (this.sequence += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result.value;
  }
}

/** Reads width/height and pixels from a PNG screenshot (8-bit RGB or RGBA). */
function decodePng(buffer) {
  let offset = 8;
  let width;
  let height;
  let colorType;
  const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") chunks.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous ? previous[i] : 0;
      const upLeft = previous && i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dl = Math.abs(estimate - left);
        const du = Math.abs(estimate - up);
        const dul = Math.abs(estimate - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      }
      current[i] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function meanLuminance(image, rect, step = 4) {
  const x0 = Math.max(0, Math.round(rect.left));
  const x1 = Math.min(image.width, Math.round(rect.right));
  const y0 = Math.max(0, Math.round(rect.top));
  const y1 = Math.min(image.height, Math.round(rect.bottom));
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      sum += luminance(image.pixels, image.channels, y * image.width + x);
      count += 1;
    }
  }
  return count ? +(sum / count).toFixed(1) : null;
}

function luminance(pixels, channels, index) {
  const base = index * channels;
  return (
    0.2126 * pixels[base] +
    0.7152 * pixels[base + 1] +
    0.0722 * pixels[base + 2]
  );
}

/**
 * Background grid check: average luminance per column in a region that sits
 * outside the 1000px shell, then autocorrelate the profile. A 32px graph paper
 * pattern peaks at lag 32; flat background peaks nowhere.
 */
function gridProfile(image, x0, x1, y0, y1) {
  const columns = [];
  for (let x = x0; x < x1; x += 1) {
    let sum = 0;
    for (let y = y0; y < y1; y += 1)
      sum += luminance(image.pixels, image.channels, y * image.width + x);
    columns.push(sum / (y1 - y0));
  }
  const mean = columns.reduce((a, b) => a + b, 0) / columns.length;
  const centered = columns.map((value) => value - mean);
  const variance =
    centered.reduce((a, b) => a + b * b, 0) / centered.length || 1e-6;
  let bestLag = 0;
  let bestScore = 0;
  const scores = {};
  for (let lag = 2; lag <= 140; lag += 1) {
    let dot = 0;
    let count = 0;
    for (let i = 0; i + lag < centered.length; i += 1) {
      dot += centered[i] * centered[i + lag];
      count += 1;
    }
    const score = dot / count / variance;
    if ([8, 16, 24, 32, 64, 96, 128].includes(lag))
      scores[lag] = score.toFixed(2);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return {
    meanLuminance: mean.toFixed(1),
    min: Math.min(...columns).toFixed(1),
    max: Math.max(...columns).toFixed(1),
    bestLag,
    bestScore: bestScore.toFixed(2),
    scores,
  };
}

const COLLECT = `(() => {
  const style = (selector, properties, pseudo) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const computed = getComputedStyle(element, pseudo);
    return Object.fromEntries(properties.map((p) => [p, computed.getPropertyValue(p)]));
  };
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const overlaps = (a, b) => !a || !b ? null : !(a.left >= b.right || a.right <= b.left || a.top >= b.bottom || a.bottom <= b.top);
  // Colours resolve through a 1x1 canvas so oklch()/color-mix() land on real
  // sRGB values; WCAG contrast then says whether a hairline or an ink colour
  // is actually legible instead of leaving that to the eye.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // Clear rather than pre-fill: a black primer would bake a semi-transparent
  // colour down into an opaque one and hide the alpha the hairlines rely on.
  const toRgb = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (fg, bg) => {
    const a = fg[3];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
  };
  const luminance = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const la = luminance(a), lb = luminance(b);
    return +((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2);
  };
  const bg = over(toRgb(getComputedStyle(document.body).backgroundColor), [255, 255, 255, 1]);
  const token = (name) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return raw ? ratioToken(raw) : null;
  };
  function ratioToken(raw) {
    const rgb = toRgb(raw);
    return { rgb: rgb.slice(0, 3).map(Math.round).join(","), over: rgb[3] < 1, contrast: contrast(over(rgb, bg), bg) };
  }
  const elementColor = (selector, prop = "color") => {
    const el = document.querySelector(selector);
    if (!el) return null;
    return ratioToken(getComputedStyle(el).getPropertyValue(prop));
  };
  // Translucent fills (panels, tints, rails) are where dark mode quietly
  // disappears: a 6% tint over a dark ground is almost nothing.
  const surface = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      fill: ratioToken(cs.backgroundColor),
      rail: cs.borderLeftWidth === "0px" ? null : ratioToken(cs.borderLeftColor),
      rule: cs.borderTopWidth === "0px" ? null : ratioToken(cs.borderTopColor),
    };
  };
  const nav = document.querySelector(".app-nav");
  const badge = box(".console-score");
  const ipText = box(".console-address .ip-text");
  const meta = box(".console-facts");
  return {
    theme: document.documentElement.className || "(light)",
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    fontLoaded: {
      mono: document.fonts.check('16px "Geist Mono Variable"'),
      sans: document.fonts.check('16px "Geist Variable"'),
    },
    background: getComputedStyle(document.body).backgroundColor,
    grid: style("body", [], "::before"),
    readoutValue: style(".readout-value", ["font-family", "font-size", "font-weight", "color", "animation-name"]),
    readoutLabel: style(".console-score .readout-label", ["font-size", "letter-spacing", "text-transform", "color"]),
    consoleHeading: style(".console-heading", ["font-size", "font-weight", "letter-spacing"]),
    consoleAddress: style(".console-address", ["font-family", "font-size", "font-weight", "letter-spacing"]),
    consoleAddressIp: style(".console-address .ip-text", ["font-family", "font-size"]),
    consoleScore: style(".console-score", ["border-left-color", "border-left-width", "text-align"]),
    consoleScoreValue: style(".console-score strong", ["font-family", "font-size", "color"]),
    consoleFacts: style(".console-facts > div + div", ["border-top-width", "border-top-color"]),
    nav: style(".app-nav", ["position", "background-color", "padding-bottom", "margin-bottom", "border-bottom-width", "border-top-width", "border-radius"]),
    pageHeading: style(".page-heading h1", ["font-size", "font-weight", "letter-spacing"]),
    pageHeadingRule: style(".page-heading", ["border-bottom-width", "border-bottom-color", "padding-bottom"]),
    toolSubnav: style(".tool-subnav", ["border-bottom-width"]),
    toolSubnavActiveTab: (() => {
      const link = document.querySelector('.tool-subnav a[aria-current="page"]');
      if (!link) return null;
      const after = getComputedStyle(link, "::after");
      return { label: link.textContent.trim(), afterHeight: after.height, afterBackground: after.backgroundColor, background: getComputedStyle(link).backgroundColor, fontWeight: getComputedStyle(link).fontWeight };
    })(),
    factsRow: style(".facts > div", [
      "border-top-width",
      "border-bottom-width",
      "font-size",
      "padding-top",
    ]),
    // Second row on purpose: the first row is exempt from the top rule, so
    // probing it would always read 0 and never prove the hairline exists.
    ipDossierRow: style(".ip-dossier .facts > div:nth-child(2)", [
      "border-top-width",
      "border-top-color",
      "border-bottom-width",
      "padding-top",
      "font-size",
      "min-height",
    ]),
    ipDossierFirstRow: style(".ip-dossier .facts > div:first-child", [
      "border-top-width",
    ]),
    aiFactsRow: style(".ai-diagnostics .facts > div:nth-child(2)", [
      "border-top-width",
      "padding-top",
      "min-height",
    ]),
    ipResultRow: style(".ip-result-grid .facts > div:nth-child(2)", [
      "border-top-width",
      "border-bottom-width",
      "padding-top",
      "min-height",
    ]),
    factsValue: style(".facts dd", ["font-variant-numeric", "font-weight", "text-align"]),
    tableHead: style(".data-table th", ["font-size", "letter-spacing", "text-transform", "border-bottom-width", "background-color"]),
    tableCell: style(".data-table td", ["border-bottom-width", "padding-top"]),
    tableZebra: (() => {
      const row = document.querySelector(".data-table tbody tr:nth-child(even)");
      return row ? getComputedStyle(row).backgroundColor : null;
    })(),
    homeCardBox: style(".home-primary-card", [
      "background-color",
      "border-radius",
      "box-shadow",
      "border-top-width",
      "padding-top",
    ]),
    homeCardContentPad: style('.home-primary-card > [data-slot="card-content"]', [
      "padding-left",
      "padding-right",
    ]),
    homeConnectivityCard: style(".home-connectivity-card", [
      "background-color",
      "border-radius",
      "border-top-width",
    ]),
    homeShortcutsCard: style(".home-shortcuts", [
      "background-color",
      "border-radius",
      "border-top-width",
    ]),
    pingItem: style(".home-connectivity-card .ping-item", [
      "border-top-width",
      "border-radius",
      "background-color",
    ]),
    shortcutRow: style(".home-shortcuts .shortcut-grid > a", [
      "padding-left",
      "border-radius",
      "border-bottom-width",
    ]),
    shortcutFeature: style(".home-shortcuts .shortcut-feature", [
      "border-left-width",
      "border-left-color",
      "border-radius",
      "background-color",
    ]),
    toolCardRule: style(".tool-card", ["border-top-width", "border-top-color"]),
    toolCardBox: style(".tool-card", ["background-color", "border-radius", "box-shadow", "padding-top"]),
    toolCardHeaderPad: style('.tool-card > [data-slot="card-header"]', ["padding-left", "padding-right"]),
    toolCardContentPad: style('.tool-card > [data-slot="card-content"]', ["padding-left", "padding-right"]),
    dossier: style(".ip-dossier-top", ["border-top-width", "border-radius", "background-color"]),
    ipDetailAddress: style(".ip-dossier-head .ip-text", ["font-family", "font-size"]),
    navActiveTab: (() => {
      const tab = document.querySelector('.app-nav [role="tab"][data-state="active"]');
      if (!tab) return null;
      const after = getComputedStyle(tab, "::after");
      return { label: tab.textContent.trim(), afterContent: after.content, afterHeight: after.height, afterBackground: after.backgroundColor };
    })(),
    // Dark mode is where transparent surfaces and alpha hairlines go wrong, so
    // every value below is reported as a WCAG ratio against the page ground.
    palette: {
      background: bg.slice(0, 3).map(Math.round).join(","),
      tokens: {
        foreground: token("--foreground"),
        mutedForeground: token("--muted-foreground"),
        subtle: token("--subtle"),
        border: token("--border"),
        dataGood: token("--data-good"),
        dataWarn: token("--data-warn"),
        dataBad: token("--data-bad"),
      },
      rendered: {
        hairlinesFacts: elementColor(".facts > div:nth-child(2)", "border-top-color"),
        hairlineToolCard: elementColor(".tool-card", "border-top-color"),
        hairlineConsoleBar: elementColor(".console-bar", "border-bottom-color"),
        heading: elementColor(".console-heading"),
        factsLabel: elementColor(".facts dt"),
        factsValue: elementColor(".facts dd"),
        tableHead: elementColor(".data-table th"),
        readoutLabel: elementColor(".readout-label"),
        subnavLink: elementColor(".tool-subnav a"),
      },
    },
    surfaces: {
      dossierTop: surface(".ip-dossier-top"),
      consoleScore: surface(".console-score"),
      scoreRail: surface(".console-score"),
      latencyBadge: surface(".latency-badge"),
      pingItem: surface(".home-connectivity-card .ping-item"),
      shortcutFeature: surface(".home-shortcuts .shortcut-feature"),
      shortcutIcon: surface(".shortcut-icon"),
    },
    // The loading shimmer paints a gradient through the text, so if the
    // highlight sits at the same luminance as the ink it stops being visible.
    sweepShine: (() => {
      const probe = document.createElement("span");
      probe.className = "sweep-shine";
      probe.textContent = "000";
      probe.style.position = "fixed";
      probe.style.left = "-9999px";
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      // Written without escape sequences on purpose: oxlint cannot read
      // through the template literal and flags every backslash inside it.
      // Colour names are spelled out so the gradient function name itself is
      // not matched: an unparsable value leaves the canvas fillStyle intact
      // and would silently report the previously parsed colour instead.
      const image = cs.backgroundImage.replace(/ +/g, " ");
      const ink = cs.color;
      probe.remove();
      const stops = [
        ...image.matchAll(/(?:rgba|rgb|oklch|hsl|color)[(][^)]*[)]/g),
      ].map((m) => m[0]);
      const lum = stops.map((s) => luminance(over(toRgb(s), bg)));
      const spread = lum.length
        ? +(Math.max(...lum) / Math.max(0.0001, Math.min(...lum))).toFixed(2)
        : null;
      return {
        ink,
        stops: stops.length,
        spread,
        image: image.slice(0, 120),
      };
    })(),
    ipText: style(".ip-text", ["font-family", "font-size", "font-variant-numeric"]),
    eyebrow: style(".eyebrow", ["font-size", "letter-spacing", "text-transform"]),
    // After zeroing the card padding every section title, the console headline
    // and the readouts have to start at the same x. A mismatch here means the
    // surfaces drifted off the page gutter.
    gutters: {
      consoleHeading: box(".console-heading"),
      primaryContent: box('.home-primary-card > [data-slot="card-content"]'),
      primaryAddress: box(".home-primary-card .console-address"),
      connectivityTitle: box('.home-connectivity-card [data-slot="card-title"]'),
      connectivityItem: box(".home-connectivity-card .ping-item"),
      shortcutsTitle: box('.home-shortcuts [data-slot="card-title"]'),
      shortcutRow: box(".home-shortcuts .shortcut-grid > a"),
      shortcutLabel: box(".home-shortcuts .shortcut-grid > a strong"),
    },
    // Map tiles are raster images, so a light basemap inside a dark page can
    // only be caught by sampling the rendered pixels.
    mapBox: box(".leaflet-container"),
    navBox: box(".app-nav"),
    navOverflow: nav ? { scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, scrollHeight: nav.scrollHeight, clientHeight: nav.clientHeight } : null,
    pageOverflow: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth },
    badge, ipText, meta,
    scorePanelOverlapsAddress: overlaps(badge, ipText),
    scorePanelOverlapsFacts: overlaps(badge, meta),
    hideIp: localStorage.getItem("ip-tools:hide-ip"),
    sections: document.querySelectorAll("main section, .home-page > *").length,
  };
})()`;

const browser = new WebSocket(target);
await new Promise((resolve) =>
  browser.addEventListener("open", resolve, { once: true }),
);
const cdp = new Cdp(browser);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

async function waitFor(selector) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await cdp.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    );
    if (ready) return;
    await sleep(500);
  }
  throw new Error(`${selector} did not render`);
}

async function shot(
  name,
  {
    theme,
    width,
    height,
    full = false,
    path = "/",
    // Not `.console-address`: the address only renders once the upstream IP
    // lookup answers, and a rate-limited upstream must not fail the run.
    ready = ".home-primary-card",
  },
) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  const url = new URL(path, APP).href;
  await cdp.send("Page.navigate", { url });
  await waitFor(ready);
  // The app stores both preferences itself, so set them the way its own UI would.
  await cdp.evaluate(
    `localStorage.setItem("theme", ${JSON.stringify(theme)}); localStorage.setItem("ip-tools:hide-ip", "true");`,
  );
  await cdp.send("Page.navigate", { url });
  await waitFor(ready);
  await sleep(7000);

  let clip;
  if (full) {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const content = metrics.cssContentSize ?? metrics.contentSize;
    clip = {
      x: 0,
      y: 0,
      width,
      height: Math.min(Math.round(content.height), 4200),
      scale: 1,
    };
  }
  const capture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: full,
    ...(clip ? { clip } : {}),
  });
  const file = `${OUT}/${name}.png`;
  writeFileSync(file, Buffer.from(capture.data, "base64"));
  const report = await cdp.evaluate(COLLECT);
  return {
    path: file,
    report,
    bytes: Buffer.from(capture.data, "base64").length,
  };
}

const light = await shot("home-light", {
  theme: "light",
  width: 1440,
  height: 1000,
});
const dark = await shot("home-dark", {
  theme: "dark",
  width: 1440,
  height: 1000,
});
const mobile = await shot("home-light-mobile", {
  theme: "light",
  width: 390,
  height: 844,
});
const fullPage = await shot("home-light-full", {
  theme: "light",
  width: 1440,
  height: 1000,
  full: true,
});

// Tool pages share ToolCard / Facts / DataTable / tool-subnav, so one IP detail
// page plus the status page is enough to see whether the language propagated.
const ipDetail = await shot("tool-ip-detail", {
  theme: "light",
  width: 1440,
  height: 1000,
  path: "/network/ip/1.1.1.1",
  ready: ".ip-dossier-top",
});
const statusPage = await shot("tool-status", {
  theme: "light",
  width: 1440,
  height: 1000,
  path: "/status",
  ready: ".service-status-page",
});
// The AI diagnostics page carries its own `facts` density override, so it is
// the other place where the row rules used to be zeroed out.
const aiPage = await shot("tool-ai-claude", {
  theme: "light",
  width: 1440,
  height: 1000,
  path: "/ai/claude",
  ready: ".ai-diagnostics",
});
const browserPage = await shot("tool-browser", {
  theme: "light",
  width: 1440,
  height: 1000,
  path: "/browser/environment",
  ready: ".tool-card",
});

// Dark equivalents of the tool pages: the light pass proved the structure, this
// one proves the surfaces and hairlines survive on the dark ground.
const darkIpDetail = await shot("tool-ip-detail-dark", {
  theme: "dark",
  width: 1440,
  height: 1000,
  path: "/network/ip/1.1.1.1",
  ready: ".ip-dossier-top",
});
const darkBrowser = await shot("tool-browser-dark", {
  theme: "dark",
  width: 1440,
  height: 1000,
  path: "/browser/environment",
  ready: ".tool-card",
});
const darkAi = await shot("tool-ai-claude-dark", {
  theme: "dark",
  width: 1440,
  height: 1000,
  path: "/ai/claude",
  ready: ".ai-diagnostics",
});
// The exits page carries a Leaflet map: the one place where a third-party
// raster surface can stay bright while everything around it turns dark.
const exitsLight = await shot("tool-exits", {
  theme: "light",
  width: 1440,
  height: 1000,
  path: "/network/exits",
  ready: ".page-heading",
});
const exitsDark = await shot("tool-exits-dark", {
  theme: "dark",
  width: 1440,
  height: 1000,
  path: "/network/exits",
  ready: ".page-heading",
});
const darkStatus = await shot("tool-status-dark", {
  theme: "dark",
  width: 1440,
  height: 1000,
  path: "/status",
  ready: ".service-status-page",
});

/** One scannable block per page: every colour as a contrast ratio vs the ground. */
function paletteLine(label, report) {
  const { background, tokens: t, rendered: r } = report.palette;
  const f = (v) => (v ? v.contrast.toFixed(2).padStart(5) : "  n/a");
  return [
    `${label.padEnd(20)} bg rgb(${background})`,
    `  tokens fg${f(t.foreground)} muted${f(t.mutedForeground)} subtle${f(t.subtle)} border${f(t.border)} good${f(t.dataGood)} warn${f(t.dataWarn)} bad${f(t.dataBad)}`,
    `  rules  facts${f(r.hairlinesFacts)} card${f(r.hairlineToolCard)} bar${f(r.hairlineConsoleBar)}`,
    `  text   h${f(r.heading)} dt${f(r.factsLabel)} dd${f(r.factsValue)} th${f(r.tableHead)} label${f(r.readoutLabel)} nav${f(r.subnavLink)}`,
    `  fills  dossier${f(report.surfaces.dossierTop?.fill)} score${f(report.surfaces.consoleScore?.fill)} badge${f(report.surfaces.latencyBadge?.fill)} ping${f(report.surfaces.pingItem?.fill)} claude${f(report.surfaces.shortcutFeature?.fill)} icon${f(report.surfaces.shortcutIcon?.fill)}`,
    `  rails  claude${f(report.surfaces.shortcutFeature?.rail)} scoreRail${f(report.surfaces.scoreRail?.rail)}`,
    // Spread is the luminance max/min across the gradient stops; the absolute
    // value tracks the page's inherited ink, so compare it within a page.
    `  shimmer ink=${report.sweepShine.ink} stops=${report.sweepShine.stops} spread=${report.sweepShine.spread ?? "n/a"}`,
  ].join("\n");
}
for (const [label, page] of [
  ["home light", light],
  ["home dark", dark],
  ["ip detail light", ipDetail],
  ["ip detail dark", darkIpDetail],
  ["browser light", browserPage],
  ["browser dark", darkBrowser],
  ["ai light", aiPage],
  ["ai dark", darkAi],
  ["status light", statusPage],
  ["status dark", darkStatus],
]) {
  console.log(paletteLine(label, page.report));
}

console.log("=== map basemap (mean luminance of the map box) ===");
for (const [label, page] of [
  ["exits light", exitsLight],
  ["exits dark", exitsDark],
]) {
  const rect = page.report.mapBox;
  const image = decodePng(readFileSync(page.path));
  console.log(
    `${label.padEnd(14)} map=${rect ? `${rect.width}x${rect.height}` : "not rendered"} meanLuminance=${rect ? meanLuminance(image, rect) : "n/a"} pageMean=${meanLuminance(image, { left: 0, right: image.width, top: 0, bottom: image.height })}`,
  );
}

console.log("=== light ===");
console.log(JSON.stringify(light.report, null, 2));
console.log("=== dark ===");
console.log(JSON.stringify(dark.report, null, 2));
console.log("=== ip detail (tool page primitives) ===");
console.log(
  JSON.stringify(
    {
      pageHeading: ipDetail.report.pageHeading,
      pageHeadingRule: ipDetail.report.pageHeadingRule,
      toolSubnav: ipDetail.report.toolSubnav,
      toolSubnavActiveTab: ipDetail.report.toolSubnavActiveTab,
      factsRow: ipDetail.report.factsRow,
      ipDossierRow: ipDetail.report.ipDossierRow,
      ipDossierFirstRow: ipDetail.report.ipDossierFirstRow,
      ipResultRow: ipDetail.report.ipResultRow,
      factsValue: ipDetail.report.factsValue,
      tableHead: ipDetail.report.tableHead,
      tableCell: ipDetail.report.tableCell,
      tableZebra: ipDetail.report.tableZebra,
      toolCardRule: ipDetail.report.toolCardRule,
      dossier: ipDetail.report.dossier,
      ipDetailAddress: ipDetail.report.ipDetailAddress,
    },
    null,
    2,
  ),
);
console.log("=== browser page (ToolCard / Facts / DataTable) ===");
console.log(
  JSON.stringify(
    {
      pageHeading: browserPage.report.pageHeading,
      pageHeadingRule: browserPage.report.pageHeadingRule,
      toolCardRule: browserPage.report.toolCardRule,
      toolCardBox: browserPage.report.toolCardBox,
      toolCardHeaderPad: browserPage.report.toolCardHeaderPad,
      toolCardContentPad: browserPage.report.toolCardContentPad,
      factsRow: browserPage.report.factsRow,
      factsValue: browserPage.report.factsValue,
      tableHead: browserPage.report.tableHead,
      tableCell: browserPage.report.tableCell,
      tableZebra: browserPage.report.tableZebra,
    },
    null,
    2,
  ),
);
console.log("=== ai diagnostics page ===");
console.log(
  JSON.stringify(
    {
      pageHeading: aiPage.report.pageHeading,
      toolCardRule: aiPage.report.toolCardRule,
      factsRow: aiPage.report.factsRow,
      aiFactsRow: aiPage.report.aiFactsRow,
      toolSubnavActiveTab: aiPage.report.toolSubnavActiveTab,
    },
    null,
    2,
  ),
);
console.log("=== status page ===");
console.log(
  JSON.stringify(
    {
      pageHeading: statusPage.report.pageHeading,
      pageHeadingRule: statusPage.report.pageHeadingRule,
      toolSubnavActiveTab: statusPage.report.toolSubnavActiveTab,
      tableHead: statusPage.report.tableHead,
      factsRow: statusPage.report.factsRow,
    },
    null,
    2,
  ),
);
console.log("=== mobile ===");
console.log(
  JSON.stringify(
    {
      theme: mobile.report.theme,
      nav: mobile.report.nav,
      navBox: mobile.report.navBox,
      navOverflow: mobile.report.navOverflow,
      pageOverflow: mobile.report.pageOverflow,
      scorePanelOverlapsAddress: mobile.report.scorePanelOverlapsAddress,
      scorePanelOverlapsFacts: mobile.report.scorePanelOverlapsFacts,
      readoutValue: mobile.report.readoutValue,
    },
    null,
    2,
  ),
);

for (const [label, image] of [
  ["light", light],
  ["dark", dark],
  ["full", fullPage],
  ["mobile", mobile],
]) {
  const decoded = decodePng(readFileSync(image.path));
  // Left margin of the 1000px shell: background only, so any pattern is the grid.
  const x0 = label === "mobile" ? 4 : 30;
  const x1 = label === "mobile" ? 40 : 200;
  const profile = gridProfile(decoded, x0, x1, 300, 700);
  console.log(
    `grid[${label}] ${decoded.width}x${decoded.height} mean=${profile.meanLuminance} min=${profile.min} max=${profile.max} bestLag=${profile.bestLag} bestScore=${profile.bestScore} scores=${JSON.stringify(profile.scores)}`,
  );
}

console.log(
  "screenshots:",
  [
    light,
    dark,
    mobile,
    fullPage,
    ipDetail,
    darkIpDetail,
    statusPage,
    darkStatus,
    browserPage,
    darkBrowser,
    aiPage,
    darkAi,
    exitsLight,
    exitsDark,
  ]
    .map((s) => `${s.path} (${Math.round(s.bytes / 1024)} KiB)`)
    .join(", "),
);

browser.close();
chrome?.kill();
// Chrome keeps a lock on the profile for a moment after exit; cleanup is best effort.
try {
  await sleep(1500);
  rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(0);
