/*
 * MyRide Bus Card — school bus status for the My Ride K-12 integration
 * (https://github.com/penguincrest/ha-myride).
 *
 * Shows the active run (AM before `switch_time`, PM after): status, a live
 * arrival countdown, next stop, distance, driver and GPS freshness.  Uses only
 * the documented Lovelace custom-card API (setConfig / hass / getCardSize /
 * getGridOptions / getStubConfig / getConfigForm), so it does not depend on
 * Home Assistant frontend internals.
 */

const CARD_TYPE = "myride-bus-card";
const RUNS = ["am", "pm"];
const RUN_FIELDS = ["status", "next_stop", "distance", "tracker"];
const LIVE_STATUSES = ["On Time", "Early", "Late", "Vehicle Past Stop"];
const STALE_GPS_MINUTES = 5;
const RUN_DONE_GRACE_MINUTES = 15;
const REFRESH_MS = 30000;

const STATUS_COLORS = {
  "On Time": "var(--success-color, #43a047)",
  Early: "var(--info-color, #039be5)",
  Late: "var(--warning-color, #ffa600)",
  "Vehicle Past Stop": "var(--warning-color, #ffa600)",
  "No Vehicle Location": "var(--error-color, #db4437)",
};
const NEUTRAL_COLOR = "var(--disabled-text-color, #9e9e9e)";

const LABELS = {
  title: "Title",
  switch_time: "Show the PM run from",
  status_am: "Bus status sensor",
  next_stop_am: "Next bus stop sensor",
  distance_am: "Distance to next stop sensor",
  tracker_am: "Bus tracker",
  status_pm: "Bus status sensor",
  next_stop_pm: "Next bus stop sensor",
  distance_pm: "Distance to next stop sensor",
  tracker_pm: "Bus tracker",
};

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/*
 * My Ride K-12 times come in three shapes:
 *   "1900-01-01T16:20:00"        planned time of day, local wall-clock
 *   "2026-11-09T14:05:13"        live ETA from the hub, UTC without an offset
 *   "2026-11-09T09:05:13-05:00"  live ETA already normalized (penguincrest fork)
 */
function parseStopTime(value, now) {
  if (!value) return null;
  const text = String(value);
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "0"] = m;
  if (y === "1900") {
    const local = new Date(now);
    local.setHours(Number(h), Number(mi), Number(s), 0);
    return local;
  }
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return new Date(text);
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

function parseSwitchTime(value) {
  const m = String(value || "12:00").match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 12 * 60;
}

const titleCase = (text) =>
  String(text || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// "RAMSEY, RARLANDO" -> "Rarlando Ramsey"
function driverName(raw) {
  if (!raw) return "";
  const [last, first] = String(raw).split(",").map((p) => p.trim());
  return titleCase(first ? `${first} ${last}` : last);
}

function ago(date, now) {
  const minutes = Math.round((now - date) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

const STYLE = `
  :host { display: block; }
  .card { padding: 16px; }
  .top { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .top ha-icon { color: var(--state-icon-color, var(--primary-text-color)); --mdc-icon-size: 28px; }
  .title { flex: 1; font-size: 18px; font-weight: 500; color: var(--primary-text-color); }
  .pill {
    font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
    color: var(--text-primary-color, #fff); background: var(--pill-color);
    white-space: nowrap;
  }
  .hero { font-size: 28px; font-weight: 600; margin-top: 14px; color: var(--primary-text-color); line-height: 1.2; }
  .sub { font-size: 14px; color: var(--secondary-text-color); margin-top: 4px; }
  .rows { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--primary-text-color); }
  .row ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); flex: none; }
  .row .label { color: var(--secondary-text-color); }
  .row.warn, .row.warn ha-icon { color: var(--warning-color, #ffa600); }
  .msg { color: var(--secondary-text-color); font-size: 14px; margin-top: 12px; }
`;

class MyRideBusCard extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._stateRefs = {};
    this._timer = null;

    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style><ha-card><div class="card"></div></ha-card>`;
    this._content = root.querySelector(".card");
    root.addEventListener("click", (ev) => {
      if (ev.target.closest(".top")) this._showMoreInfo();
    });
    root.addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" || ev.key === " ") && ev.target.closest(".top")) {
        ev.preventDefault();
        this._showMoreInfo();
      }
    });
  }

  setConfig(config) {
    const hasRun = RUNS.some((run) => config?.[`status_${run}`] || config?.[`next_stop_${run}`]);
    if (!hasRun) {
      throw new Error("Set at least status_am/next_stop_am or status_pm/next_stop_pm");
    }
    this._config = config;
    this._stateRefs = {};
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const ids = this._entityIds();
    if (!ids.some((id) => hass.states[id] !== this._stateRefs[id])) return;
    ids.forEach((id) => { this._stateRefs[id] = hass.states[id]; });
    this._render();
  }

  connectedCallback() {
    // Keep the countdown and GPS age current between state updates
    this._timer = setInterval(() => this._render(), REFRESH_MS);
    this._render();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    return 5;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  static getStubConfig(hass) {
    const ids = Object.keys(hass.states);
    const find = (domain, suffix) =>
      ids.find((id) => id.startsWith(`${domain}.`) && id.endsWith(suffix)) || "";
    const config = {};
    RUNS.forEach((run) => {
      config[`status_${run}`] = find("sensor", `_bus_status_${run}`);
      config[`next_stop_${run}`] = find("sensor", `_next_bus_stop_${run}`);
      config[`distance_${run}`] = find("sensor", `_bus_distance_to_next_stop_${run}`);
      config[`tracker_${run}`] = find("device_tracker", `_bus_${run}`);
    });
    return config;
  }

  static getConfigForm() {
    const pick = (domain) => ({ entity: { domain, integration: "myride" } });
    const runSchema = (run) => [
      { name: `status_${run}`, selector: pick("sensor") },
      { name: `next_stop_${run}`, selector: pick("sensor") },
      { name: `distance_${run}`, selector: pick("sensor") },
      { name: `tracker_${run}`, selector: pick("device_tracker") },
    ];
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "switch_time", default: "12:00", selector: { time: {} } },
        { name: "", type: "expandable", title: "Morning (AM) run", flatten: true, schema: runSchema("am") },
        { name: "", type: "expandable", title: "Afternoon (PM) run", flatten: true, schema: runSchema("pm") },
      ],
      computeLabel: (schema) => LABELS[schema.name],
    };
  }

  _entityIds() {
    return RUNS.flatMap((run) => RUN_FIELDS.map((f) => this._config[`${f}_${run}`])).filter(Boolean);
  }

  _activeRun(now) {
    const configured = RUNS.filter((r) => this._config[`status_${r}`] || this._config[`next_stop_${r}`]);
    if (configured.length === 1) return configured[0];
    const minutes = now.getHours() * 60 + now.getMinutes();
    return minutes < parseSwitchTime(this._config.switch_time) ? "am" : "pm";
  }

  _state(field, run) {
    const id = this._config[`${field}_${run}`];
    return id ? this._hass.states[id] : undefined;
  }

  _showMoreInfo() {
    if (!this._config || !this._hass) return;
    const run = this._activeRun(new Date());
    const entityId =
      this._config[`tracker_${run}`] || this._config[`next_stop_${run}`] || this._config[`status_${run}`];
    if (!entityId) return;
    const event = new Event("hass-more-info", { bubbles: true, composed: true });
    event.detail = { entityId };
    this.dispatchEvent(event);
  }

  _render() {
    if (!this._config || !this._hass) return;
    const now = new Date();
    const run = this._activeRun(now);
    const status = this._state("status", run);
    const next = this._state("next_stop", run);
    const distance = this._state("distance", run);
    const tracker = this._state("tracker", run);

    const sAttrs = status?.attributes || {};
    const nAttrs = next?.attributes || {};
    const busNumber = sAttrs.bus_number || nAttrs.bus_number || "";
    const statusText = status?.state && !["unknown", "unavailable"].includes(status.state) ? status.state : "";

    const planned = parseStopTime(nAttrs.planned_time, now);
    const eta = parseStopTime(nAttrs.tyler_eta, now) || planned;
    const finished =
      statusText === "Completed" ||
      next?.state === "Completed" ||
      (eta && now - eta > RUN_DONE_GRACE_MINUTES * 60000);
    const live = !finished && LIVE_STATUSES.includes(statusText);

    const timeFmt = { hour: "numeric", minute: "2-digit" };
    let hero;
    let sub;
    if (!status && !next) {
      hero = "Bus not found";
      sub = "Check the entities in the card settings";
    } else if (finished) {
      hero = "Completed";
      sub = `${run.toUpperCase()} run is done for today`;
    } else if (live && eta) {
      const minutes = Math.round((eta - now) / 60000);
      hero = minutes <= 0 ? "Arriving now" : `Arriving in ${minutes} min`;
      sub = `ETA ${eta.toLocaleTimeString([], timeFmt)}`;
    } else if (eta) {
      hero = `Scheduled ${eta.toLocaleTimeString([], timeFmt)}`;
      sub = "Bus not on route yet";
    } else {
      hero = statusText || "No schedule";
      sub = "";
    }
    sub = [sub, busNumber && `Bus ${busNumber}`, run.toUpperCase()].filter(Boolean).join(" · ");

    const pillText = finished ? "Completed" : statusText || "No Status";
    const pillColor = (!finished && STATUS_COLORS[statusText]) || NEUTRAL_COLOR;

    const rows = [];
    if (next && !finished && next.state && !["No Stops", "unknown", "unavailable"].includes(next.state)) {
      const left = Number(nAttrs.stops_remaining);
      const leftText = Number.isFinite(left) && left > 0 ? ` · ${left} stop${left === 1 ? "" : "s"} left` : "";
      rows.push(this._row("mdi:map-marker", `<span class="label">Next stop</span> ${esc(titleCase(next.state))}${esc(leftText)}`));
    }
    if (live) {
      const miles = Number(distance?.state ?? nAttrs.distance_to_stop_miles);
      if (Number.isFinite(miles)) {
        const approaching = (distance?.attributes?.is_approaching ?? nAttrs.is_approaching) ? " · approaching" : "";
        rows.push(this._row("mdi:map-marker-distance", `${esc(miles.toFixed(1))} mi away${esc(approaching)}`));
      }
    }
    const driver = driverName(sAttrs.driver_name);
    if (driver) rows.push(this._row("mdi:steering", `<span class="label">Driver</span> ${esc(driver)}`));
    const logTime = tracker?.attributes?.last_log_time ? new Date(tracker.attributes.last_log_time) : null;
    if (live && logTime && !Number.isNaN(logTime.getTime())) {
      const stale = now - logTime > STALE_GPS_MINUTES * 60000;
      rows.push(
        this._row(
          stale ? "mdi:crosshairs-question" : "mdi:crosshairs-gps",
          stale ? `GPS stale — last seen ${esc(ago(logTime, now))}` : `GPS updated ${esc(ago(logTime, now))}`,
          stale ? "warn" : ""
        )
      );
    }

    const title = this._config.title || "School Bus";
    this._content.innerHTML = `
      <div class="top" role="button" tabindex="0" aria-label="Show bus details">
        <ha-icon icon="mdi:bus-school"></ha-icon>
        <div class="title">${esc(title)}</div>
        <span class="pill" style="--pill-color: ${pillColor}">${esc(pillText)}</span>
      </div>
      <div class="hero">${esc(hero)}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
      ${rows.length ? `<div class="rows">${rows.join("")}</div>` : ""}
    `;
  }

  _row(icon, html, cls = "") {
    return `<div class="row ${cls}"><ha-icon icon="${icon}"></ha-icon><span>${html}</span></div>`;
  }
}

if (!customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, MyRideBusCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TYPE,
    name: "MyRide Bus",
    description: "School bus status and arrival countdown for My Ride K-12.",
    preview: true,
    documentationURL: "https://github.com/penguincrest/myride-bus-card",
  });
}
