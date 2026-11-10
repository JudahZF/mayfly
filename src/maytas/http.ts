import type { EntryContent } from "../shared/entry";
import {
  LayoutChanged,
  type Maytas,
  type MaytasProfile,
  type MaytasReview,
  type MaytasRow,
  type MaytasSession,
  MaytasUnavailable,
  SignInFailed,
} from "./types";

/**
 * The real Maytas Hub client. Mapped on 10 November 2026 against the University of Chichester's Maytas Hub (ASP.NET MVC on IIS):
 * - Sign-in is a multipart POST of Username, Password and __RequestVerificationToken to
 *   /Login/Login. Success is a redirect away from the login page.
 * - The OTJ log is a custom tab. Its page holds every row as hidden inputs
 *   (`...Rows[n].DataValues[i].Obj` with a `fieldname`), the option lists of the Add Row
 *   form, and the learner's planned hours and dates. It is about 12 MB.
 * - RECORDID is the row ID. KSB codes are stored as text such as "K28K16" or "S2 S3 S12".
 * - The KSB descriptions are only on the Skill Scan page, in the criteria cells ("K1: ...").
 * - Reviews are on the Engagements page (10 per page, newest first). Forms that the learner
 *   must complete, such as the Progress Review form, are queued on the dashboard. A completed
 *   review is kept as a PDF on its engagement.
 * - Every write is what the browser does: change one row of the grid form, then Save submits
 *   the whole form (every other row as it is) as multipart/form-data to the form's action.
 *   Add fills the first hidden "new row" and marks it active, edit changes the fields of the
 *   row, and delete marks the row inactive.
 */
/**
 * A save submits the whole form, so a late save would undo every save after it. Two guards:
 * no save starts while an earlier one is unsettled (even from an older session), and the
 * form read before a post is cut off well inside the bridge's 60 s write time-out, so an old
 * copy of the form is never posted late.
 */
const formReadLimitMs = 45_000;

export function createHttpMaytas(config: { url: string; username: string; password: string }): Maytas {
  const base = new URL(`${config.url.replace(/\/+$/, "")}/`);
  let otjPath: string | null = null;
  const saving = { busy: false };

  return {
    async signIn() {
      const http = createHttp(base);
      const login = await http.get("Login");
      const token = inputs(login.body).get("__RequestVerificationToken");
      if (!token) throw new LayoutChanged("The Maytas sign-in page does not look as expected.");

      const form = new FormData();
      form.set("__RequestVerificationToken", token);
      form.set("Username", config.username);
      form.set("Password", config.password);
      const posted = await http.send(new URL("Login/Login", base), { method: "POST", body: form });
      const next = posted.headers.get("location");
      await posted.body?.cancel();
      if (posted.status >= 500) throw new MaytasUnavailable(`Maytas answered the sign-in with ${posted.status}.`);
      if (!next || /login/i.test(next)) throw new SignInFailed("Maytas refused the username or password.");

      const landing = await http.get(next);
      otjPath ??= landing.body.match(/\/etrack\/(CustomTab\/Learner\?componentId=\w+&(?:amp;)?title=Off%20The%20Job%20Activity)/)?.[1]?.replace("&amp;", "&") ?? null;
      if (!otjPath) throw new LayoutChanged("Mayfly cannot find the Off The Job Activity tab in Maytas.");
      return createSession(http, base, otjPath, landing.body, saving);
    },
  };
}

function createSession(http: Http, base: URL, otjPath: string, dashboard: string, saving: { busy: boolean }): MaytasSession {
  let cached: { at: number; page: OtjPage } | null = null;

  /** One page load serves both a profile read and the grid read that follows it. */
  async function load(maxAgeMs: number) {
    if (cached && Date.now() - cached.at <= maxAgeMs) return cached.page;
    const { body } = await http.get(otjPath);
    cached = { at: Date.now(), page: parseOtjPage(body) };
    return cached.page;
  }

  /** Loads the form fresh, changes it, and submits it once. The reply is ignored: only the grid tells the truth. */
  async function submit(change: (html: string) => ReturnType<typeof formControls>) {
    if (saving.busy) throw new MaytasUnavailable("An earlier save to Maytas has not finished. Mayfly sends nothing until it has.");
    saving.busy = true;
    cached = null;
    try {
      const { body } = await http.get(otjPath, AbortSignal.timeout(formReadLimitMs));
      const { action, controls } = change(body);
      const form = new FormData();
      for (const { name, value } of controls) form.append(name, value);
      const res = await http.send(new URL(action, base), { method: "POST", body: form });
      await res.body?.cancel();
    } finally {
      saving.busy = false;
    }
  }

  return {
    saving: () => saving.busy,
    async getProfile() {
      const { profile } = await load(0);
      // Descriptions are a nicety: without a Skill Scan page, the KSBs still work by code.
      const texts = await http.get("Action/MVCMenuClick/Skill%20Scan").then(
        (page) => parseKsbTexts(page.body),
        () => new Map<string, string>(),
      );
      return { ...profile, ksbs: profile.ksbs.map((ksb) => ({ ...ksb, text: texts.get(ksb.code) ?? "" })) };
    },
    listOtj: async () => (await load(10_000)).rows,
    async listReviews() {
      const { body } = await http.get("Action/MVCMenuClick/Engagements");
      return parseReviews(body, dashboard, base);
    },
    addOtj: (row) => submit((html) => rowForm(html, { op: "add", content: row })),
    editOtj: (rowId, row) => submit((html) => rowForm(html, { op: "edit", rowId, content: row })),
    deleteOtj: (rowId) => submit((html) => rowForm(html, { op: "delete", rowId })),
    signOut: async () => {
      await http.get("Account/Logout");
    },
  };
}

type Http = ReturnType<typeof createHttp>;

/** fetch with a cookie jar and redirects followed by hand, so every hop keeps the cookies. */
function createHttp(base: URL) {
  const jar = new Map<string, string>();

  async function send(url: URL, init: RequestInit = {}) {
    if (url.host !== base.host) throw new LayoutChanged(`Maytas redirected to another host: ${url.host}`);
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (Mayfly)", Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    }).catch((error: unknown) => {
      throw new MaytasUnavailable(`Maytas did not answer: ${error instanceof Error ? error.message : String(error)}`);
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    return res;
  }

  async function get(path: string, signal?: AbortSignal) {
    let url = new URL(path.replace(/^\/etrack\//, ""), base);
    for (let hop = 0; hop < 6; hop++) {
      const res = await send(url, signal ? { signal } : {});
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      if (res.status >= 400) throw new MaytasUnavailable(`Maytas answered ${res.status} for ${url.pathname}.`);
      const body = await res.text().catch((error: unknown) => {
        throw new MaytasUnavailable(`Maytas stopped sending ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (!path.startsWith("Login") && /id="frmLogin"/.test(body)) throw new MaytasUnavailable("The Maytas session ended.");
      return { url, body };
    }
    throw new MaytasUnavailable(`Too many redirects from ${path}.`);
  }

  return { send, get };
}

type OtjPage = { rows: MaytasRow[]; profile: MaytasProfile };

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export const decodeEntities = (text: string) =>
  text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, code: string) =>
    code[0] === "#"
      ? String.fromCodePoint(code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1)))
      : (entities[code] ?? all),
  );

/** The inside of a tag, where a quoted value may hold ">". */
const tagBody = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;

const attr = (tag: string, name: string) => {
  const value = tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : decodeEntities(value);
};

const inputTags = (html: string) => [...html.matchAll(new RegExp(`<input\\b${tagBody}>`, "g"))].map(([tag]) => tag);

/** Values of the named inputs outside the grid rows. */
function inputs(html: string) {
  const values = new Map<string, string>();
  for (const tag of inputTags(html)) {
    const name = attr(tag, "name");
    if (name && !name.includes("Rows[")) values.set(name, attr(tag, "value") ?? "");
  }
  return values;
}

/** The options of the Add Row form's `<select>` with this field name: value code to label. */
function options(html: string, fieldName: string) {
  const start = html.search(new RegExp(`<select\\b[^>]*fieldname="${fieldName}"[^>]*name="[^"]*ModalVM`));
  const end = html.indexOf("</select>", start);
  if (start < 0 || end < 0) throw new LayoutChanged(`The Add Row form has no ${fieldName} list.`);
  const list = new Map<string, string>();
  for (const [, value = "", label = ""] of html.slice(start, end).matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
    const code = decodeEntities(value).trim();
    if (code) list.set(code, decodeEntities(label).trim());
  }
  return list;
}

/** The KSB checklist with this field name: its checkbox values (K01 to K28) and their fixed width. */
function checklist(html: string, fieldName: string) {
  const start = html.search(new RegExp(`<div class="M5tabCheckList[^>]*fieldname="${fieldName}"`));
  if (start < 0) return { values: [], width: 0 };
  const open = html.slice(start, html.indexOf(">", start));
  const rest = html.slice(start + open.length, start + 200_000);
  const next = rest.indexOf("M5tabCheckList");
  const values = [...(next < 0 ? rest : rest.slice(0, next)).matchAll(/type="checkbox"[^>]*value="([^"]*)"/g)].map(([, v = ""]) => v);
  return { values, width: Number(attr(open, "data-shortlength")) || 3 };
}

/** "K28K16", "S2 S3 S12S4 " and "K05" all hold codes; Mayfly writes them as K28, S2, K5. */
export const ksbCodes = (text: string) => [...new Set([...text.matchAll(/([KSB])\s*0*(\d+)/g)].map(([, letter, digits]) => `${letter}${Number(digits)}`))];

/** KSB descriptions from the Skill Scan page. The learner's own comments are in other cells and are skipped. */
export function parseKsbTexts(html: string) {
  const texts = new Map<string, string>();
  for (const [, cell = ""] of html.matchAll(/<td colspan="2" class="notCentred">([\s\S]*?)<\/td>/g)) {
    const text = decodeEntities(cell.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const [, letter, digits, description] = text.match(/^([KSB])\s?0*(\d{1,2})\s*:\s*(.+)$/) ?? [];
    const code = `${letter}${Number(digits)}`;
    if (description && !texts.has(code)) texts.set(code, description);
  }
  return texts;
}

/**
 * Engagements from the Engagements page, joined with the forms queued on the dashboard.
 * Each engagement is a block of "Label: value" lines; the queue is a table with one row per form.
 */
export function parseReviews(engagements: string, dashboard: string, base: URL): MaytasReview[] {
  const date = (text: string) => (text.trim() ? isoDate(text.trim()) : null);
  const forms = new Map<string, NonNullable<MaytasReview["form"]>>();
  for (const [row, open = ""] of dashboard.matchAll(new RegExp(`(<tr\\b${tagBody}class="dcModalClickableRow"${tagBody}>)[\\s\\S]*?<\\/tr>`, "g"))) {
    const cell = (field: string) => decodeEntities(row.match(new RegExp(`fieldname='${field}'[^>]*>([^<]*)<`))?.[1] ?? "").trim();
    const visitId = attr(open, "data-visid");
    const formId = attr(open, "data-formid");
    const traineeId = attr(open, "data-traineeid");
    if (!visitId || !formId || !traineeId) continue;
    forms.set(visitId, {
      name: cell("form"),
      status: cell("status"),
      dueDate: date(cell("duedate")),
      url: new URL(`CustomTab/VisitDataCollection?formRecordId=${formId}&traineeId=${traineeId}`, base).href,
    });
  }

  return [...engagements.matchAll(/<div class="row visitLink mobileVisit" data-href="([^"]+)">([\s\S]*?)<\/div>/g)].map(([, href = "", block = ""]) => {
    const path = decodeEntities(href);
    const visitId = path.match(/TrVisit\/([^?/]+)/)?.[1];
    if (!visitId) throw new LayoutChanged("An engagement in Maytas has no visit ID.");
    const field = (label: string) => {
      const text = decodeEntities(block.match(new RegExp(`<span>${label}:([^<]*)<\\/span>`))?.[1] ?? "").trim();
      return text || null;
    };
    const planned = date(field("Planned Date") ?? "");
    if (!planned) throw new LayoutChanged("An engagement in Maytas has no planned date.");
    return {
      visitId,
      type: field("Engagement Type") ?? "",
      plannedDate: planned,
      actualDate: date(field("Actual Date") ?? ""),
      outcome: field("Outcome"),
      staff: field("Staff"),
      url: new URL(path.replace(/^\/etrack\//, ""), base).href,
      form: forms.get(visitId) ?? null,
    };
  });
}

/** "26/09/2023 00:00:00" to "2023-09-26". */
const isoDate = (text: string) => {
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) throw new LayoutChanged(`Maytas shows a date that Mayfly cannot read: ${text}`);
  return `${match[3]}-${match[2]}-${match[1]}`;
};

/** The cells of each grid row, by field name. The hidden "new row" templates are not rows. */
function rowCells(html: string) {
  const cells = new Map<number, Map<string, string>>();
  for (const tag of inputTags(html)) {
    const index = attr(tag, "name")?.match(/\.Rows\[(\d+)\]\.DataValues\[\d+\]\.Obj$/)?.[1];
    const field = attr(tag, "fieldname");
    if (index === undefined || !field) continue;
    const row = cells.get(Number(index)) ?? new Map<string, string>();
    row.set(field, attr(tag, "value") ?? "");
    cells.set(Number(index), row);
  }
  return cells;
}

/** The learner's standard: the one most rows use, such as U_ST001923. */
function mostUsedStandard(cells: Map<number, Map<string, string>>) {
  const counts = new Map<string, number>();
  for (const cell of cells.values()) {
    const code = cell.get("U_STANDARDS")?.trim();
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function parseOtjPage(html: string): OtjPage {
  if (!html.includes('fieldname="OTJT_DATE"')) throw new LayoutChanged("The Maytas OTJ page does not look as expected.");
  const wheres = options(html, "OTJT_WHERE");
  const methods = options(html, "OTJT_METHOD");
  const standards = options(html, "U_STANDARDS");
  const cells = rowCells(html);

  const rows = [...cells.values()].map((cell): MaytasRow => {
    const value = (field: string) => cell.get(field)?.trim() ?? "";
    const rowId = value("RECORDID");
    const hours = Number(value("OTJT_DURATION"));
    if (!rowId || !Number.isFinite(hours)) throw new LayoutChanged("A Maytas OTJ row has no RECORDID or duration.");
    const standard = value("U_STANDARDS");
    const content: EntryContent = {
      date: isoDate(value("OTJT_DATE")),
      centihours: Math.round(hours * 100),
      where: wheres.get(value("OTJT_WHERE")) ?? value("OTJT_WHERE"),
      method: methods.get(value("OTJT_METHOD")) ?? value("OTJT_METHOD"),
      describe: value("OTJT_KNOWLEDGE"),
      reflect: value("U_REFLECT"),
      anythingElse: value("OTJT_OTHER") || null,
      ksbs: standard ? ["K", "S", "B"].flatMap((kind) => ksbCodes(value(`${standard}${kind}`))) : [],
    };
    return { rowId, ...content };
  });

  const standardCode = mostUsedStandard(cells);
  const page = inputs(html);
  const field = (name: string) => {
    for (const [key, value] of page) {
      if (key.endsWith(".FieldName") && value === name) return page.get(key.replace(/\.FieldName$/, ".Value")) ?? null;
    }
    return null;
  };
  const planned = Number(field("OTJT_PLANNEDHOURS"));
  const end = field("EXPCOMPLETIONDATE");

  return {
    rows,
    profile: {
      targetCentihours: Number.isFinite(planned) ? Math.round(planned * 100) : 0,
      standard: (standardCode && standards.get(standardCode)) ?? "",
      endDate: end ? isoDate(end) : null,
      ksbs: standardCode
        ? ["K", "S", "B"].flatMap((kind) => checklist(html, `${standardCode}${kind}`).values.flatMap(ksbCodes)).map((code) => ({ code, text: "" }))
        : [],
      methods: [...methods.values()],
      wheres: [...wheres.values()],
    },
  };
}

type Control = { name: string; value: string; fieldname: string | undefined };

/**
 * What a browser sends when this form is submitted by script (no submit button):
 * every named control in document order, except disabled ones, buttons, and checkboxes
 * or radios that are not checked. A text input drops line breaks, as browsers do.
 */
export function formControls(html: string, formId: string) {
  const open = html.match(new RegExp(`<form\\b${tagBody}\\sid="${formId}"${tagBody}>`));
  if (!open || open.index === undefined) throw new LayoutChanged(`The Maytas page has no ${formId} form.`);
  const from = open.index + open[0].length;
  const body = html.slice(from, html.indexOf("</form>", from));
  const controls: Control[] = [];
  const tags = new RegExp(`<(input|select|textarea|button)\\b${tagBody}>`, "gi");

  for (let match = tags.exec(body); match; match = tags.exec(body)) {
    const [tag, kind = ""] = match;
    let inner = "";
    if (kind === "select" || kind === "textarea") {
      const close = body.indexOf(`</${kind}>`, tags.lastIndex);
      inner = body.slice(tags.lastIndex, close);
      tags.lastIndex = close;
    }
    const name = attr(tag, "name");
    if (!name || kind === "button" || /\sdisabled[\s=/>]/.test(tag)) continue;
    const control = (value: string) => controls.push({ name, value, fieldname: attr(tag, "fieldname") });

    if (kind === "select") {
      const choices = [...inner.matchAll(new RegExp(`<option\\b${tagBody}>([^<]*)`, "g"))].map(([option, label = ""]) => ({
        value: attr(option, "value") ?? decodeEntities(label).trim(),
        selected: /\sselected[\s=/>]/.test(option.slice(0, option.indexOf(">") + 1)),
      }));
      const chosen = /\smultiple[\s=/>]/.test(tag) ? choices.filter((c) => c.selected) : [choices.findLast((c) => c.selected) ?? choices[0]];
      for (const choice of chosen) if (choice) control(choice.value);
    } else if (kind === "textarea") {
      control(decodeEntities(inner.replace(/^\r?\n/, "")).replace(/\r?\n/g, "\r\n"));
    } else {
      const type = (attr(tag, "type") ?? "text").toLowerCase();
      if (["submit", "image", "reset", "button", "file"].includes(type)) continue;
      const toggle = type === "checkbox" || type === "radio";
      if (toggle && !/\schecked[\s=/>]/.test(tag)) continue;
      const value = attr(tag, "value") ?? (toggle ? "on" : "");
      control(type === "hidden" || toggle ? value : value.replace(/[\r\n]/g, ""));
    }
  }
  return { action: attr(open[0], "action") ?? "", controls };
}

export type RowChange =
  | { op: "add"; content: EntryContent }
  | { op: "edit"; rowId: string; content: EntryContent }
  | { op: "delete"; rowId: string };

/**
 * The form a browser submits after one change to the grid: the page's form as it is, with
 * one row changed. Add fills the first hidden new row and marks it active; edit sets the
 * fields of the row with this RECORDID; delete marks that row inactive.
 */
export function rowForm(html: string, change: RowChange) {
  const { action, controls } = formControls(html, "frmCustomTab");
  let slot = ".NewRows[0].";
  if (change.op !== "add") {
    const ids = controls.filter((c) => c.fieldname === "RECORDID" && c.value.trim() === change.rowId);
    const index = ids.length === 1 ? ids[0]?.name.match(/\.Rows\[(\d+)\]\./)?.[1] : undefined;
    if (index === undefined) throw new LayoutChanged(`Maytas does not have exactly one row ${change.rowId}.`);
    slot = `.Rows[${index}].`;
  }
  const inSlot = (name: string) => name.includes(slot);

  const active = controls.find((c) => inSlot(c.name) && c.name.endsWith(".Active"));
  if (active?.value !== (change.op === "add" ? "False" : "True")) {
    throw new LayoutChanged(change.op === "add" ? "The grid has no free new row." : `Row ${change.rowId} is not active in the grid.`);
  }
  if (change.op !== "edit") active.value = change.op === "add" ? "True" : "False";
  if (change.op === "delete") return { action, controls };

  const values = rowValues(html, change.content);
  const filled = new Set<string>();
  for (const control of controls) {
    const value = control.fieldname === undefined || !inSlot(control.name) ? undefined : values.get(control.fieldname);
    if (value === undefined || control.fieldname === undefined) continue;
    control.value = value;
    filled.add(control.fieldname);
  }
  const missing = [...values.keys()].filter((f) => !filled.has(f));
  if (missing.length > 0) throw new LayoutChanged(`The grid row has no field for ${missing.join(", ")}.`);
  return { action, controls };
}

/** The grid values of an entry, as the Add Row and Edit forms write them. */
function rowValues(html: string, content: EntryContent) {
  const standard = mostUsedStandard(rowCells(html));
  if (!standard) throw new LayoutChanged("Mayfly cannot tell which standard to file the row under.");
  const codeOf = (fieldName: string, label: string) => {
    for (const [code, text] of options(html, fieldName)) if (text === label) return code;
    throw new LayoutChanged(`Maytas has no ${fieldName} option "${label}".`);
  };
  const ksbText = (kind: string) => {
    const { values, width } = checklist(html, `${standard}${kind}`);
    const ticked = values.filter((v) => content.ksbs.includes(ksbCodes(v)[0] ?? ""));
    const wanted = content.ksbs.filter((code) => code.startsWith(kind));
    if (ticked.length !== wanted.length) throw new LayoutChanged(`The Maytas form cannot tick every KSB of this entry: ${wanted.join(" ")}.`);
    return ticked.map((v) => v.padEnd(width)).join("");
  };
  const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  const [year, month, day] = content.date.split("-");

  return new Map([
    ["OTJT_DATE", `${day}/${month}/${year}`],
    ["OTJT_DURATION", (content.centihours / 100).toFixed(2)],
    ["OTJT_METHOD", codeOf("OTJT_METHOD", content.method)],
    ["OTJT_WHERE", codeOf("OTJT_WHERE", content.where)],
    ["OTJT_KNOWLEDGE", oneLine(content.describe)],
    ["U_REFLECT", oneLine(content.reflect)],
    ["OTJT_OTHER", oneLine(content.anythingElse ?? "")],
    ["U_STANDARDS", standard],
    ...["K", "S", "B"].map((kind) => [`${standard}${kind}`, ksbText(kind)] as const),
  ]);
}
