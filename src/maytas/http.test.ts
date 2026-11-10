import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHttpMaytas, formControls, parseKsbTexts, parseOtjPage, parseReviews, type RowChange, rowForm } from "./http";

/** The shape of the real OTJ page, cut down to one row. All values are made up. */
const cell = (row: number, i: number, field: string, value: string) =>
  `<td><input fieldname="${field}" name="Controls[1].Children[0].Rows[${row}].DataValues[${i}].Obj" type="hidden" value="${value}" /></td>`;

const page = `
<input name="Controls[0].Children[2].FieldName" type="hidden" value="OTJT_PLANNEDHOURS" />
<input name="Controls[0].Children[2].Value" type="hidden" value="900.00" />
<input name="Controls[0].Children[3].FieldName" type="hidden" value="EXPCOMPLETIONDATE" />
<input name="Controls[0].Children[3].Value" type="hidden" value="31/07/2028" />
<table><tr>
  <td><input name="Controls[1].Children[0].Rows[0].LineId" type="hidden" value="0" />
    <input name="Controls[1].Children[0].Rows[0].Active" type="hidden" value="True" /></td>
  ${cell(0, 0, "RECORDID", "40")}
  ${cell(0, 1, "OTJT_DATE", "08/10/2024&#32;00:00:00")}
  ${cell(0, 2, "OTJT_DURATION", "1.25")}
  ${cell(0, 3, "OTJT_METHOD", "CTR")}
  ${cell(0, 4, "OTJT_WHERE", "UNI")}
  ${cell(0, 5, "OTJT_KNOWLEDGE", "Version control &amp; CI")}
  ${cell(0, 6, "U_REFLECT", "Rebase&#13;&#10;before merge")}
  ${cell(0, 7, "OTJT_OTHER", "")}
  ${cell(0, 8, "U_STANDARDS", "U_ST001923")}
  ${cell(0, 9, "U_ST001923K", "K5 K15K16")}
  ${cell(0, 10, "U_ST001923S", "S2 S3 S12S4 ")}
  ${cell(0, 11, "U_ST001923B", "")}
  ${cell(0, 12, "U_ST0024K", "K99")}
</tr>
<tr class="newRow"><td><input fieldname="RECORDID" name="Controls[1].Children[0].NewRows[0].DataValues[0].Obj" value="" /></td></tr>
</table>
<div class="modal">
  <select class="M5tabDDL" fieldname="OTJT_WHERE" name="Controls[1].Children[0].ModalVM.ModalTabs[0].Controls[1].Value">
    <option value="">---</option><option value="UNI">University</option><option value="WRK">Workplace</option>
  </select>
  <select class="M5tabDDL" fieldname="OTJT_METHOD" name="Controls[1].Children[0].ModalVM.ModalTabs[0].Controls[2].Value">
    <option value="">---</option><option value="CTR">Classroom Training</option><option value="MTG">Meetings</option>
  </select>
  <select class="M5tabDDL" fieldname="U_STANDARDS" name="Controls[1].Children[0].ModalVM.ModalTabs[0].Controls[3].Value">
    <option value="">---</option><option value="U_ST0024&#32;&#32;">Electrical Engineer</option><option value="U_ST001923">DTSP Software Engineer</option>
  </select>
  <div class="M5tabCheckList M5tabContFullWidth" fieldname="U_ST001923K" data-shortlength="3">
    <input type="checkbox" value="K05" /><label>K5</label><input type="checkbox" value="K15" /><label>K15</label>
  </div>
  <div class="M5tabCheckList M5tabContFullWidth" fieldname="U_ST001923S" data-shortlength="3">
    <input type="checkbox" value="S02" /><label>S2</label>
  </div>
  <div class="M5tabCheckList M5tabContFullWidth" fieldname="U_ST001923B" data-shortlength="2">
    <input type="checkbox" value="B1" /><label>B1</label>
  </div>
</div>`;

test("the OTJ page parses into rows and a profile, with codes mapped to labels and KSB text split into codes", () => {
  const { rows, profile } = parseOtjPage(page);
  expect(rows).toEqual([
    {
      rowId: "40",
      date: "2024-10-08",
      centihours: 125,
      where: "University",
      method: "Classroom Training",
      describe: "Version control & CI",
      reflect: "Rebase\r\nbefore merge",
      anythingElse: null,
      ksbs: ["K5", "K15", "K16", "S2", "S3", "S12", "S4"],
    },
  ]);
  expect(profile).toEqual({
    targetCentihours: 90_000,
    standard: "DTSP Software Engineer",
    endDate: "2028-07-31",
    ksbs: ["K5", "K15", "S2", "B1"].map((code) => ({ code, text: "" })),
    methods: ["Classroom Training", "Meetings"],
    wheres: ["University", "Workplace"],
  });
});

test("KSB descriptions come from the Skill Scan criteria cells, not from the learner's comments", () => {
  const scan = `
    <tr class="collapse childRowCollapse"><td></td><td colspan="2" class="notCentred">K1: How organisations adapt &amp; exploit
      digital technology.</td><td colspan="2"> 7 </td></tr>
    <tr class="collapse childRowCollapse"><td></td><td colspan="2" class="notCentred">S07: Work effectively within teams.</td></tr>
    <tr><td width="5%">1</td><td class="notCentred" width="20%">S7: I have little experience of this.</td></tr>
    <tr class="collapse childRowCollapse"><td></td><td colspan="2" class="notCentred">Overall score</td></tr>`;
  expect([...parseKsbTexts(scan)]).toEqual([
    ["K1", "How organisations adapt & exploit digital technology."],
    ["S7", "Work effectively within teams."],
  ]);
});

test("the form is copied as a browser submits it", () => {
  const form = `<form action="/etrack/CustomTab" enctype="multipart/form-data" id="frmCustomTab" method="post">
    <input name="__RequestVerificationToken" type="hidden" value="tok" />
    <input name="text" type="text" value="a &gt; b > c" />
    <input name="off" type="text" value="x" disabled="disabled" />
    <input name="box" type="checkbox" value="Y" />
    <input name="ticked" type="checkbox" checked="checked" />
    <select name="pick"><option value="">---</option><option value="B" selected="selected">Bee</option></select>
    <select name="first"><option value="A">A</option><option value="B">B</option></select>
    <select name="locked" disabled="disabled"><option value="Z" selected="selected">Z</option></select>
    <textarea name="note">
line one
line two</textarea>
    <button name="save" type="submit">Save</button>
  </form><input name="outside" value="no" />`;
  const { action, controls } = formControls(form, "frmCustomTab");
  expect(action).toBe("/etrack/CustomTab");
  expect(controls.map(({ name, value }) => [name, value])).toEqual([
    ["__RequestVerificationToken", "tok"],
    ["text", "a > b > c"],
    ["ticked", "on"],
    ["pick", "B"],
    ["first", "A"],
    ["note", "line one\r\nline two"],
  ]);
});

describe("writes change one row of the form and nothing else", () => {
  const slot = (i: number, field: string, extra = "") =>
    `<input fieldname="${field}" name="Controls[1].Children[0].NewRows[0].DataValues[${i}].Obj" type="hidden" value="" ${extra}/>`;
  const html = `<form action="/etrack/CustomTab" id="frmCustomTab" method="post">${page}
    <table><tr class="newRow">
      <input name="Controls[1].Children[0].NewRows[0].Active" type="hidden" value="False" />
      ${slot(0, "RECORDID")}${slot(1, "OTJT_DATE")}${slot(2, "OTJT_DURATION")}
      <select fieldname="OTJT_METHOD" name="Controls[1].Children[0].NewRows[0].DataValues[3].Obj" disabled="disabled"><option value="">---</option></select>
      ${slot(3, "OTJT_METHOD")}${slot(4, "OTJT_WHERE")}${slot(5, "OTJT_KNOWLEDGE")}${slot(6, "U_REFLECT")}${slot(7, "OTJT_OTHER")}
      ${slot(8, "TRAINEEID", 'value="T1"')}${slot(9, "U_STANDARDS")}
      ${slot(10, "U_ST001923K")}${slot(11, "U_ST001923S")}${slot(12, "U_ST001923B")}
    </tr></table></form>`;
  const content = {
    date: "2026-11-10",
    centihours: 300,
    where: "University",
    method: "Classroom Training",
    describe: "COMS601",
    reflect: "APIs within\nmobile apps",
    anythingElse: null,
    ksbs: ["K5", "S2"],
  };

  /** The controls that the change sets to another value, as row and field. */
  const changes = (change: RowChange) => {
    const before = formControls(html, "frmCustomTab").controls;
    const after = rowForm(html, change).controls;
    expect(after.map((c) => c.name)).toEqual(before.map((c) => c.name));
    return Object.fromEntries(
      after.flatMap((c, i) => (c.value === before[i]?.value ? [] : [[`${c.name.match(/(New)?Rows\[\d+\]/)?.[0]} ${c.fieldname ?? "Active"}`, c.value]])),
    );
  };

  test("add fills the first free new row and marks it active", () => {
    expect(changes({ op: "add", content })).toEqual({
      "NewRows[0] Active": "True",
      "NewRows[0] OTJT_DATE": "10/11/2026",
      "NewRows[0] OTJT_DURATION": "3.00",
      "NewRows[0] OTJT_METHOD": "CTR",
      "NewRows[0] OTJT_WHERE": "UNI",
      "NewRows[0] OTJT_KNOWLEDGE": "COMS601",
      "NewRows[0] U_REFLECT": "APIs within mobile apps",
      "NewRows[0] U_STANDARDS": "U_ST001923",
      "NewRows[0] U_ST001923K": "K05",
      "NewRows[0] U_ST001923S": "S02",
    });
  });

  test("edit sets the fields of the row with that RECORDID, in the form's own formats", () => {
    const [row] = parseOtjPage(html).rows;
    if (!row) throw new Error("fixture row missing");
    const { rowId, ...current } = row;
    expect(changes({ op: "edit", rowId, content: { ...current, reflect: "Rebase first", ksbs: ["K5", "K15", "S2"] } })).toEqual({
      "Rows[0] OTJT_DATE": "08/10/2024",
      "Rows[0] U_REFLECT": "Rebase first",
      "Rows[0] U_ST001923K": "K05K15",
      "Rows[0] U_ST001923S": "S02",
    });
  });

  test("delete marks only that row inactive", () => {
    expect(changes({ op: "delete", rowId: "40" })).toEqual({ "Rows[0] Active": "False" });
  });

  test("a row that is not there, or a KSB that the form cannot tick, stops the write", () => {
    expect(() => rowForm(html, { op: "delete", rowId: "41" })).toThrow("exactly one row 41");
    expect(() => rowForm(html, { op: "add", content: { ...content, ksbs: ["K16"] } })).toThrow("cannot tick");
  });
});

test("reviews come from the Engagements page, joined with the forms queued on the dashboard", () => {
  const engagement = (visitId: string, planned: string, actual: string, outcome: string) => `
    <h4>11/2026</h4>
    <div class="row visitLink mobileVisit" data-href="/etrack/Visits/TrVisit/${visitId}?traineeid=T1">
      <span class="col-xs-1"><i class="icon-calendar"></i></span>
      <span class="col-xs-11"><span>Engagement Type: Progress Review</span><br /><span>Planned Date: ${planned}</span><br />
      <span>Actual Date: ${actual}</span><br /><span>Outcome: ${outcome}</span><br /><span>Staff: A Tutor</span></span>
    </div>`;
  const engagements = engagement("V2", "18/11/2026 00:00:00", "", "") + engagement("V1", "25/06/2026 00:00:00", "25/06/2026 00:00:00", "Completed");
  const dashboard = `<tr class="dcModalClickableRow" data-formid="3" data-visid="V2" data-formtype="" data-traineeid="T1" data-employerid="">
    <td fieldname='form'>Progress Review</td><td fieldname='visitdate'>18/11/2026</td><td fieldname='duedate'>18/11/2026</td>
    <td fieldname='status'>Not Started</td></tr>`;
  const base = new URL("https://maytas.example/etrack/");
  expect(parseReviews(engagements, dashboard, base)).toEqual([
    {
      visitId: "V2",
      type: "Progress Review",
      plannedDate: "2026-11-18",
      actualDate: null,
      outcome: null,
      staff: "A Tutor",
      url: "https://maytas.example/etrack/Visits/TrVisit/V2?traineeid=T1",
      form: {
        name: "Progress Review",
        status: "Not Started",
        dueDate: "2026-11-18",
        url: "https://maytas.example/etrack/CustomTab/VisitDataCollection?formRecordId=3&traineeId=T1",
      },
    },
    {
      visitId: "V1",
      type: "Progress Review",
      plannedDate: "2026-06-25",
      actualDate: "2026-06-25",
      outcome: "Completed",
      staff: "A Tutor",
      url: "https://maytas.example/etrack/Visits/TrVisit/V1?traineeid=T1",
      form: null,
    },
  ]);
});

describe("saves", () => {
  afterEach(() => {
    (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test("no save starts while an earlier one has not settled, so a late save cannot undo a newer one", async () => {
    const form = `<form action="/etrack/CustomTab" id="frmCustomTab" method="post">${page}
      <table><tr class="newRow"><input name="Controls[1].Children[0].NewRows[0].Active" type="hidden" value="False" />
      ${["RECORDID", "OTJT_DATE", "OTJT_DURATION", "OTJT_METHOD", "OTJT_WHERE", "OTJT_KNOWLEDGE", "U_REFLECT", "OTJT_OTHER", "U_STANDARDS", "U_ST001923K", "U_ST001923S", "U_ST001923B"]
        .map((f, i) => `<input fieldname="${f}" name="Controls[1].Children[0].NewRows[0].DataValues[${i}].Obj" type="hidden" value="" />`)
        .join("")}</tr></table></form>`;
    let releaseFormRead = () => {};
    const formRead = new Promise<void>((resolve) => (releaseFormRead = resolve));
    const posts: string[] = [];
    let formReads = 0;
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });
      if (url.pathname === "/etrack/Login") return html('<input name="__RequestVerificationToken" type="hidden" value="t" />');
      if (url.pathname === "/etrack/Login/Login") return html("", 302, { location: "/etrack/Default.aspx" });
      if (url.pathname === "/etrack/Default.aspx") return html('<a href="/etrack/CustomTab/Learner?componentId=c1&title=Off%20The%20Job%20Activity">OTJ</a>');
      if (url.pathname === "/etrack/CustomTab/Learner") {
        if (formReads++ === 0) await formRead;
        return html(form);
      }
      if (url.pathname === "/etrack/CustomTab" && init?.method === "POST") {
        posts.push(url.pathname);
        return html("saved");
      }
      return html("not found", 404);
    }) as typeof fetch);

    const session = await createHttpMaytas({ url: "https://maytas.example/etrack", username: "u", password: "p" }).signIn();
    const entry = { date: "2026-11-10", centihours: 100, where: "University", method: "Meetings", describe: "A", reflect: "B", anythingElse: null, ksbs: [] };
    const first = session.addOtj(entry);
    await expect(session.addOtj(entry)).rejects.toThrow("has not finished");
    releaseFormRead();
    await first;
    expect(posts).toHaveLength(1);
    await session.addOtj(entry);
    expect(posts).toHaveLength(2);
  });
});

test("a page without the OTJ grid is a layout change, not an empty log", () => {
  expect(() => parseOtjPage("<html><body>Maintenance</body></html>")).toThrow("does not look as expected");
});
