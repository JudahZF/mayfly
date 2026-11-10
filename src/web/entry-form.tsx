import { type FormEvent, type ReactNode, useState } from "react";
import { type EntryFields, entryFields } from "../shared/entry";
import { type Entry, type Profile, shiftDate, todayIso } from "./lib";

export type FormValues = {
  date: string;
  hours: string;
  where: string;
  method: string;
  describe: string;
  reflect: string;
  startTime: string;
  anythingElse: string;
  ksbs: string[];
};

type Field = keyof FormValues;
type Errors = Partial<Record<Field, string>>;

export const blankValues = (last?: Pick<FormValues, "where" | "method">): FormValues => ({
  date: todayIso(),
  hours: "",
  where: last?.where ?? "",
  method: last?.method ?? "",
  describe: "",
  reflect: "",
  startTime: "",
  anythingElse: "",
  ksbs: [],
});

export const valuesFrom = (e: Entry): FormValues => ({
  date: e.date,
  hours: String(e.centihours / 100),
  where: e.where,
  method: e.method,
  describe: e.describe,
  reflect: e.reflect,
  startTime: e.startTime ?? "",
  anythingElse: e.anythingElse ?? "",
  ksbs: e.ksbs,
});

const requiredText: Partial<Record<Field, string>> = {
  where: "Pick where you did it.",
  method: "Pick a method.",
  describe: "Say what you did.",
  reflect: "Say what you learned. Maytas needs it.",
};

/** Checks the values with the shared entry schema. */
export function checkValues(v: FormValues, profile: Profile): { fields: EntryFields | null; errors: Errors } {
  const hours = Number(v.hours.trim().replace(",", "."));
  const input = {
    date: v.date,
    startTime: v.startTime === "" ? null : v.startTime,
    hours: v.hours.trim() === "" ? Number.NaN : hours,
    where: v.where,
    method: v.method,
    describe: v.describe,
    reflect: v.reflect,
    anythingElse: v.anythingElse,
    ksbs: v.ksbs,
  } satisfies EntryFields;
  const errors: Errors = {};
  const parsed = entryFields.safeParse(input);
  for (const issue of parsed.success ? [] : parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field !== "string" || !(field in v) || errors[field as Field]) continue;
    const key = field as Field;
    errors[key] =
      key === "hours" && Number.isNaN(input.hours)
        ? "Enter the hours, for example 1.5."
        : key === "date"
          ? "Pick a date."
          : key === "startTime"
            ? "Use a time such as 09:30."
            : (requiredText[key] && issue.message === "Required" ? requiredText[key] : issue.message);
  }
  if (!errors.date && v.date > todayIso()) errors.date = "The date cannot be in the future.";
  if (v.where && !profile.wheres.includes(v.where)) errors.where = "Pick one of the places in the list.";
  if (v.method && !profile.methods.includes(v.method)) errors.method = "Pick one of the methods in the list.";
  return { fields: Object.keys(errors).length === 0 ? input : null, errors };
}

const quickHours = ["0.5", "1", "1.5", "2", "3", "6"];

function Choices({
  name,
  legend,
  options,
  value,
  onChange,
  error,
  required,
  children,
}: {
  name: Field;
  legend: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
  children?: ReactNode;
}) {
  return (
    <fieldset aria-describedby={error ? `e-${name}` : undefined}>
      <legend className="label">
        {legend} {required && <span className="req">(required)</span>}
      </legend>
      <div className="choices">
        {options.map((o, i) => (
          <label key={o.value} className="choice">
            <input
              type="radio"
              name={name}
              id={i === 0 ? `f-${name}` : undefined}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
        {children}
      </div>
      {error && <p id={`e-${name}`} className="error">{error}</p>}
    </fieldset>
  );
}

function TextField({
  name,
  label,
  value,
  onChange,
  error,
  required,
  hint,
  rows = 3,
}: {
  name: Field;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
  hint?: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="label" htmlFor={`f-${name}`}>
        {label} {required ? <span className="req">(required)</span> : <span className="req">(optional)</span>}
      </label>
      <textarea
        id={`f-${name}`}
        className="input"
        rows={rows}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `e-${name}` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && !error && <p className="hint mt-1">{hint}</p>}
      {error && <p id={`e-${name}`} className="error">{error}</p>}
    </div>
  );
}

/** The entry form for Log hours, Copy and Edit. Remount it with a new `key` to reset it. */
export function EntryForm({
  profile,
  initial,
  submitLabel,
  pending,
  onSubmit,
  footer,
}: {
  profile: Profile;
  initial: FormValues;
  submitLabel: string;
  pending: boolean;
  onSubmit: (fields: EntryFields) => void;
  footer?: ReactNode;
}) {
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  const set = <K extends Field>(key: K) => (value: FormValues[K]) => {
    setV((old) => ({ ...old, [key]: value }));
    setErrors((old) => ({ ...old, [key]: undefined }));
  };
  const today = todayIso();
  const yesterday = shiftDate(today, -1);

  function submit(event: FormEvent) {
    event.preventDefault();
    const { fields, errors } = checkValues(v, profile);
    setErrors(errors);
    if (fields) return onSubmit(fields);
    const first = (Object.keys(v) as Field[]).find((k) => errors[k]);
    if (first) document.getElementById(`f-${first}`)?.focus();
  }

  return (
    <form noValidate onSubmit={submit} className="space-y-5">
      <Choices
        name="date"
        legend="Date"
        required
        options={[
          { value: today, label: "Today" },
          { value: yesterday, label: "Yesterday" },
        ]}
        value={v.date}
        onChange={set("date")}
        error={errors.date}
      >
        <label className="flex items-center gap-2">
          <span className="sr-only">Other day</span>
          <input
            type="date"
            className="input w-auto"
            max={today}
            value={v.date === today || v.date === yesterday ? "" : v.date}
            aria-invalid={errors.date ? true : undefined}
            onChange={(e) => set("date")(e.target.value || today)}
          />
        </label>
      </Choices>

      <Choices
        name="hours"
        legend="Hours"
        required
        options={quickHours.map((h) => ({ value: h, label: h }))}
        value={quickHours.find((h) => Number(h) === Number(v.hours) && v.hours !== "") ?? ""}
        onChange={set("hours")}
        error={errors.hours}
      >
        <label className="flex items-center gap-2">
          <span className="sr-only">Hours, typed</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="Other"
            className="input w-24"
            value={v.hours}
            aria-invalid={errors.hours ? true : undefined}
            onChange={(e) => set("hours")(e.target.value)}
          />
        </label>
      </Choices>

      <Choices
        name="where"
        legend="Where"
        required
        options={profile.wheres.map((w) => ({ value: w, label: w }))}
        value={v.where}
        onChange={set("where")}
        error={errors.where}
      />

      <Choices
        name="method"
        legend="Method"
        required
        options={profile.methods.map((m) => ({ value: m, label: m }))}
        value={v.method}
        onChange={set("method")}
        error={errors.method}
      />

      <TextField name="describe" label="What did you do?" required value={v.describe} onChange={set("describe")} error={errors.describe} rows={2} />
      <TextField
        name="reflect"
        label="What did you learn?"
        required
        value={v.reflect}
        onChange={set("reflect")}
        error={errors.reflect}
        hint="One or two sentences. This is what makes the hours count."
      />

      <div className="grid gap-5 sm:grid-cols-[10rem_1fr]">
        <div>
          <label className="label" htmlFor="f-startTime">
            Start time <span className="req">(optional)</span>
          </label>
          <input
            id="f-startTime"
            type="time"
            className="input"
            value={v.startTime}
            aria-invalid={errors.startTime ? true : undefined}
            onChange={(e) => set("startTime")(e.target.value)}
          />
          {errors.startTime && <p className="error">{errors.startTime}</p>}
        </div>
        <TextField name="anythingElse" label="Anything else" value={v.anythingElse} onChange={set("anythingElse")} rows={1} />
      </div>

      <KsbPicker ksbs={profile.ksbs} value={v.ksbs} onChange={set("ksbs")} />

      <div className="sticky bottom-14 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-line bg-paper px-4 py-3 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
        <button type="submit" className="btn btn-primary min-h-12 flex-1 text-base sm:flex-none sm:px-8" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
        {footer}
      </div>
    </form>
  );
}

function KsbPicker({ ksbs, value, onChange }: { ksbs: Profile["ksbs"]; value: string[]; onChange: (value: string[]) => void }) {
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  return (
    <details className="panel" open={value.length > 0 ? true : undefined}>
      <summary className="cursor-pointer px-3 py-2.5 font-semibold">
        KSBs <span className="font-normal text-mid">(optional){value.length > 0 && `: ${value.join(", ")}`}</span>
      </summary>
      <ul className="rows max-h-72 overflow-y-auto border-t border-line">
        {ksbs.map((k) => (
          <li key={k.code}>
            <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-code">
              <input type="checkbox" className="mt-1 size-4 accent-river" checked={value.includes(k.code)} onChange={() => toggle(k.code)} />
              <span className="w-8 shrink-0 font-semibold">{k.code}</span>
              <span className="text-sm">{k.text}</span>
            </label>
          </li>
        ))}
      </ul>
    </details>
  );
}
