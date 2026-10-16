(() => {
  "use strict";

  // ---------- small helpers ----------
  const KEY = "app.v1";
  const PALETTE = ["#f4b6c2", "#b8d8f0", "#c5e3c0", "#f5dcaa", "#d4c4ee", "#f6c9ae", "#b5e0dc", "#e6c7e0"];
  const uid = () => Math.random().toString(36).slice(2, 9);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") el.className = v;
      else if (k === "value") continue;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(c));
    }
    if (props && props.value !== undefined) el.value = props.value;
    return el;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return dateKey(d); };
  const todayKey = () => dateKey(new Date());
  const weekStart = (k) => { const d = parseKey(k); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dateKey(d); };
  const fmt = (k, opts) => parseKey(k).toLocaleDateString(undefined, opts);

  // ---------- data ----------
  const defaultOptions = () => [
    { id: "did", label: "Did", level: "full" },
    { id: "kinda", label: "Kinda", level: "partial" },
  ];

  let state = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.habits)) return fromSaved(s);
    } catch (e) { /* fall through to a blank start */ }
    return fromSaved({});
  }
  function fromSaved(s) {
    return { habits: s.habits || [], log: s.log || {}, checkin: Object.assign({ on: false, time: "20:00" }, s.checkin) };
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { alertSheet("Could not save. Is the phone's storage full?"); }
    scheduleSync();
  }

  const slotsFor = (sub) => (sub.freq === "day" ? sub.n : 1);
  const optOf = (sub, id) => {
    if (!id) return null;
    return sub.options.find((o) => o.id === id) || { id, label: "Done", level: "partial" };
  };
  const entryOf = (date, sub) => (state.log[date] && state.log[date][sub.id]) || null;
  const marksOf = (date, sub) => (entryOf(date, sub) ? entryOf(date, sub).m : []);

  function editEntry(date, sub, fn) {
    const day = (state.log[date] = state.log[date] || {});
    const e = (day[sub.id] = day[sub.id] || { m: [], note: "" });
    fn(e);
    if (!e.m.some(Boolean) && !e.note) delete day[sub.id];
    if (!Object.keys(day).length) delete state.log[date];
    save();
  }

  function forgetSubLog(ids) {
    for (const d of Object.keys(state.log)) {
      ids.forEach((id) => delete state.log[d][id]);
      if (!Object.keys(state.log[d]).length) delete state.log[d];
    }
  }

  function weekCount(sub, date) {
    const start = weekStart(date);
    let n = 0;
    for (let i = 0; i < 7; i++) n += marksOf(addDays(start, i), sub).filter(Boolean).length;
    return n;
  }

  function freqText(sub) {
    if (sub.freq === "day") return sub.n === 1 ? "Daily" : `${sub.n}× a day`;
    return sub.n === 1 ? "Once a week" : `${sub.n}× a week`;
  }

  // the day anything was first tracked
  function earliestStart() {
    let first = todayKey();
    for (const hb of state.habits) for (const s of hb.subs) if (s.created && s.created < first) first = s.created;
    return first;
  }

  const dailySubs = (habit) => habit.subs.filter((s) => s.freq === "day");
  const weeklySubs = (habit) => habit.subs.filter((s) => s.freq === "week");

  // One daily sub-goal on one day: "full" | "partial" | "empty" | "na" (not started yet)
  function subDay(s, date) {
    if (date < s.created) return "na";
    const marks = marksOf(date, s);
    let full = 0, any = 0;
    for (let i = 0; i < s.n; i++) {
      const o = optOf(s, marks[i]);
      if (o) { any++; if (o.level === "full") full++; }
    }
    if (full === s.n) return "full";
    return any ? "partial" : "empty";
  }

  // A weekly sub-goal's ticks for the week starting `ws`: best ones first, so extra ticks still count.
  function weekTicks(s, ws) {
    const ticks = [];
    for (let i = 0; i < 7; i++) for (const id of marksOf(addDays(ws, i), s)) { const o = optOf(s, id); if (o) ticks.push(o); }
    return ticks.sort((a, b) => (b.level === "full") - (a.level === "full"));
  }
  // One status per required time, e.g. 3× a week -> ["full", "partial", "empty"]
  function weekBoxes(s, ws) {
    const ticks = weekTicks(s, ws);
    return Array.from({ length: s.n }, (_, i) => (ticks[i] ? (ticks[i].level === "full" ? "full" : "partial") : "empty"));
  }

  // Days in a row every daily sub-goal was fully done (unfinished today doesn't break it).
  // Habits with only weekly sub-goals count weeks instead. Returns { n, unit }.
  function streak(habit) {
    const today = todayKey();
    const daily = dailySubs(habit), weekly = weeklySubs(habit);
    if (daily.length) {
      const start = daily.map((s) => s.created).sort()[0];
      const dayFull = (k) => {
        const due = daily.filter((s) => k >= s.created);
        return due.length ? due.every((s) => subDay(s, k) === "full") : null;
      };
      let k = today, n = 0;
      if (dayFull(k) !== true) k = addDays(k, -1);
      for (; k >= start; k = addDays(k, -1)) {
        const ok = dayFull(k);
        if (ok === true) n++; else if (ok === false) break;
      }
      return { n, unit: "day" };
    }
    if (weekly.length) {
      const start = weekStart(weekly.map((s) => s.created).sort()[0]);
      const met = (ws) => {
        const due = weekly.filter((s) => addDays(ws, 6) >= s.created);
        return due.length ? due.every((s) => weekBoxes(s, ws).every((b) => b === "full")) : null;
      };
      let ws = weekStart(today), n = 0;
      if (met(ws) !== true) ws = addDays(ws, -7);
      for (; ws >= start; ws = addDays(ws, -7)) {
        const ok = met(ws);
        if (ok === true) n++; else if (ok === false) break;
      }
      return { n, unit: "week" };
    }
    return { n: 0, unit: "day" };
  }

  // ---------- view state ----------
  let tab = "habits";
  let editing = false;
  let viewDate = todayKey(); // the Habits page only ever shows today
  let trackMode = "week";    // "week" | "month"
  let anchor = todayKey();   // any day inside the period the tracker shows
  let selDay = todayKey();
  const openStrategies = new Set(); // habit ids whose strategies are expanded

  const app = document.getElementById("app");

  function render() {
    viewDate = todayKey();
    const y = window.scrollY;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    app.replaceChildren(tab === "habits" ? habitsPage() : trackerPage());
    window.scrollTo(0, y);
  }

  document.getElementById("tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    tab = b.dataset.tab;
    if (tab !== "habits") editing = false;
    window.scrollTo(0, 0);
    render();
  });

  // ---------- reusable controls ----------
  function choice(opts, cur, onPick, small) {
    return h("div", { class: "choice" + (small ? " small" : "") },
      opts.map((o) => h("button", { type: "button", class: o.value === cur ? "on" : "", onclick: () => onPick(o.value) }, o.label)));
  }

  function stepper(v, min, max, onChange) {
    return h("div", { class: "stepper" },
      h("button", { type: "button", "aria-label": "Less", onclick: () => onChange(Math.max(min, v - 1)) }, "−"),
      h("span", {}, v),
      h("button", { type: "button", "aria-label": "More", onclick: () => onChange(Math.min(max, v + 1)) }, "+"));
  }

  function toggle(label, checked, onChange) {
    return h("label", { class: "switch" }, h("span", {}, label),
      h("input", { type: "checkbox", class: "tgl", checked, onchange: (e) => onChange(e.target.checked) }));
  }

  // ---------- in-app pop-ups (instead of the phone's built-in boxes) ----------
  function openSheet(...content) {
    const close = () => overlay.remove();
    const overlay = h("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) close(); } }, h("div", { class: "sheet" }, content));
    document.body.append(overlay);
    return close;
  }

  function alertSheet(text) {
    const close = openSheet(h("p", { class: "msg" }, text),
      h("div", { class: "btns" }, h("button", { class: "ghost primary", onclick: () => close() }, "OK")));
  }

  function confirmSheet(text, yesLabel, onYes) {
    const close = openSheet(h("h2", {}, "Are you sure?"), h("p", { class: "msg" }, text),
      h("div", { class: "btns" },
        h("button", { class: "ghost", onclick: () => close() }, "Cancel"),
        h("button", { class: "ghost danger", onclick: () => { close(); onYes(); } }, yesLabel)));
  }

  // ---------- page 1: habits ----------
  function habitsPage() {
    const page = h("div");
    page.append(
      h("div", { class: "top" },
        h("div", {}, h("h1", {}, "Habits"), editing ? null : h("div", { class: "subtitle" }, fmt(viewDate, { weekday: "long", day: "numeric", month: "long" }))),
        h("button", { class: "ghost", onclick: () => { editing = !editing; render(); } }, editing ? "Done" : "Edit"))
    );

    page.append(checkinRow());
    if (editing) page.append(notificationsCard());

    if (!state.habits.length) {
      page.append(h("div", { class: "empty" },
        h("p", {}, "No habits yet."),
        h("button", { class: "ghost", onclick: () => { editing = true; addHabit(); } }, "Add your first habit")));
      return page;
    }

    state.habits.forEach((habit, hi) => page.append(editing ? habitEditCard(habit, hi) : habitCard(habit)));

    if (editing) page.append(h("button", { class: "ghost wide", onclick: addHabit }, "+ Add habit"), backupBox());
    return page;
  }

  // General check-in reminder: shown as a status line, changed in edit mode.
  function checkinRow() {
    const c = state.checkin;
    if (!editing) {
      const at = new Date(`1970-01-01T${c.time}`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const needsPush = c.on || state.habits.some((hb) => hb.subs.some((s) => s.remind));
      const offNote = needsPush && pushState !== "on" && pushState !== "unavailable";
      return h("div", { class: "checkin-wrap" },
        h("div", { class: "checkin" + (c.on ? "" : " off") }, c.on ? `Check-in reminder · ${at}` : "Check-in reminder · off"),
        offNote ? h("div", { class: "checkin warn" }, "Notifications are off, so reminders won't arrive. Tap Edit to turn them on.") : null);
    }
    return h("div", { class: "card", style: "--hc:var(--accent)" },
      h("div", { class: "sub stack" },
        toggle("Send me a check-in reminder", c.on, (v) => { c.on = v; save(); render(); }),
        c.on ? h("input", { type: "time", class: "plain", value: c.time, onchange: (e) => { c.time = e.target.value || "20:00"; save(); } }) : null,
        h("p", { class: "hint" }, c.on ? "One daily nudge to open the app and tick things off." : "A single daily nudge to tick off your habits.")));
  }

  function notificationsCard() {
    const copy = {
      unavailable: "Notifications aren't set up yet.",
      "needs-install": "On iPhone, notifications only work once this is added to your Home Screen. Tap Share, then Add to Home Screen, and open it from the new icon.",
      unsupported: "This browser can't receive notifications.",
      blocked: "Notifications are blocked for this app. Turn them back on in your phone's Settings, under Notifications.",
      off: "Reminders only arrive once notifications are turned on for this device.",
      on: "Notifications are on for this device.",
    }[pushState];
    return h("div", { class: "card", style: "--hc:var(--accent)" },
      h("div", { class: "sub stack" },
        h("div", { class: "lbl" }, "Notifications"),
        h("p", { class: "hint" }, copy),
        pushState === "off" ? h("button", { class: "ghost primary", onclick: enablePush }, "Turn on notifications") : null,
        pushState === "on" ? h("div", { class: "btns" },
          h("button", { class: "ghost", onclick: testPush }, "Send a test"),
          h("button", { class: "ghost", onclick: disablePush }, "Turn off")) : null));
  }

  const FLAME = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2s5.5 4.6 5.5 10.2A5.5 5.5 0 0 1 12 18a5.5 5.5 0 0 1-5.5-5.8c0-2 .9-3.6 2.1-4.7.1 1.6.9 2.7 2 2.9C10.3 7.6 12 2 12 2z"/><path d="M12 22a3.4 3.4 0 0 1-3.4-3.3c0-1.4 1.2-2.3 1.9-3.2.4.8 1 1.1 1.5 1.1.9-.7 1.4-1.7 1.4-2.7 1.2 1 2 2.5 2 4.1A3.4 3.4 0 0 1 12 22z" opacity=".55"/></svg>';
  const fireTier = (n) => (n >= 30 ? 5 : n >= 14 ? 4 : n >= 7 ? 3 : n >= 3 ? 2 : 1);

  function habitCard(habit) {
    const { n: run, unit } = streak(habit);
    const open = openStrategies.has(habit.id);
    const hasStrategies = !!(habit.strategies && habit.strategies.trim());
    const flame = h("span", { class: "flame" });
    flame.innerHTML = FLAME;
    const card = h("div", { class: "card", style: `--hc:${habit.color}` }, h("div", { class: "card-head" },
      h("h2", {}, habit.name || "Untitled"),
      hasStrategies ? h("button", { class: "strat-btn" + (open ? " open" : ""), "aria-expanded": String(open), onclick: () => { open ? openStrategies.delete(habit.id) : openStrategies.add(habit.id); render(); } }, "Strategies", h("i", {}, "▾")) : null,
      h("span", { class: "spacer" }),
      run > 0 ? h("span", { class: `streak f${fireTier(run)}`, title: `${run} ${unit}${run === 1 ? "" : "s"} in a row` }, flame, run, unit === "week" ? h("small", {}, "wk") : null) : null));
    if (open && hasStrategies) card.append(h("div", { class: "strategies" }, habit.strategies));
    if (!habit.subs.length) card.append(h("div", { class: "sub" }, h("div", { class: "sub-meta" }, "No sub-goals yet. Tap Edit to add one.")));
    for (const sub of habit.subs) card.append(subRow(sub));
    return card;
  }

  function subRow(sub) {
    const marks = marksOf(viewDate, sub);
    const slots = h("div", { class: "slots" });
    for (let i = 0; i < slotsFor(sub); i++) {
      const o = optOf(sub, marks[i]);
      slots.append(h("div", { class: "slot" },
        h("button", {
          class: "box " + (o ? o.level : ""), "aria-label": `${sub.name}: ${o ? o.label : "not done"}`,
          onclick: () => tapSlot(sub, i),
        }, o ? (o.level === "full" ? "✓" : "–") : ""),
        h("div", { class: "slot-label" }, o ? o.label : "")));
    }

    const meta = [freqText(sub)];
    if (sub.freq === "week") meta.push(`${weekCount(sub, viewDate)}/${sub.n} this week`);
    const note = (entryOf(viewDate, sub) || {}).note;

    return h("div", { class: "sub" },
      h("div", { class: "sub-main" },
        h("div", { class: "sub-name" }, sub.name || "Untitled"),
        h("div", { class: "sub-meta" }, meta.join(" · ")),
        sub.notes && note ? h("div", { class: "sub-note" }, note) : null,
        sub.notes ? h("button", { class: "notebtn" + (note ? " has" : ""), onclick: () => noteSheet(sub) }, note ? "Edit note" : "Add note") : null),
      slots);
  }

  function tapSlot(sub, i) {
    editEntry(viewDate, sub, (e) => {
      while (e.m.length < slotsFor(sub)) e.m.push(null);
      const cur = e.m[i] || null;
      if (cur == null) e.m[i] = sub.options[0].id;
      else {
        const idx = sub.options.findIndex((o) => o.id === cur);
        e.m[i] = idx + 1 < sub.options.length ? sub.options[idx + 1].id : null;
      }
    });
    render();
  }

  function noteSheet(sub) {
    const e = entryOf(viewDate, sub);
    const ta = h("textarea", { placeholder: "How did it go?", value: e ? e.note : "" });
    const close = openSheet(
      h("h2", {}, sub.name),
      h("div", { class: "field" }, h("label", {}, fmt(viewDate, { weekday: "long", day: "numeric", month: "long" })), ta),
      h("div", { class: "btns" },
        h("button", { class: "ghost", onclick: () => close() }, "Cancel"),
        h("button", { class: "ghost primary", onclick: () => { editEntry(viewDate, sub, (x) => { x.note = ta.value.trim(); }); close(); render(); } }, "Save")));
    ta.focus();
  }

  // ---------- page 1: edit mode ----------
  function addHabit() {
    state.habits.push({ id: uid(), name: "", color: PALETTE[state.habits.length % PALETTE.length], subs: [] });
    save(); render();
    const inputs = document.querySelectorAll("input.name");
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function moveHabit(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= state.habits.length) return;
    [state.habits[i], state.habits[j]] = [state.habits[j], state.habits[i]];
    save(); render();
  }

  function habitEditCard(habit, hi) {
    const card = h("div", { class: "card", style: `--hc:${habit.color}` });
    card.append(h("div", { class: "card-head" },
      h("input", { class: "name", type: "text", placeholder: "Habit name", value: habit.name, oninput: (e) => { habit.name = e.target.value; save(); } }),
      h("button", { class: "ghost small", "aria-label": "Move up", onclick: () => moveHabit(hi, -1) }, "↑"),
      h("button", { class: "ghost small", "aria-label": "Move down", onclick: () => moveHabit(hi, 1) }, "↓")));
    card.append(h("div", { class: "sub stack" },
      h("div", { class: "lbl" }, "Strategies"),
      h("textarea", { class: "plain strat-edit", placeholder: "Ideas, rules or reminders that help you stick to this habit", value: habit.strategies || "", oninput: (e) => { habit.strategies = e.target.value; save(); } })));
    for (const sub of habit.subs) {
      card.append(h("div", { class: "sub" },
        h("div", { class: "sub-main" }, h("div", { class: "sub-name" }, sub.name || "Untitled"), h("div", { class: "sub-meta" }, freqText(sub))),
        h("button", { class: "ghost small", onclick: () => subSheet(habit, sub) }, "Edit")));
    }
    card.append(h("div", { class: "card-foot" },
      h("button", { class: "ghost small", onclick: () => subSheet(habit, null) }, "+ Sub-goal"),
      h("button", { class: "ghost small danger", onclick: () => {
        confirmSheet(`Delete "${habit.name || "this habit"}" and all its history?`, "Delete", () => {
          forgetSubLog(habit.subs.map((s) => s.id));
          state.habits = state.habits.filter((x) => x !== habit);
          save(); render();
        });
      } }, "Delete habit")));
    return card;
  }

  function subSheet(habit, existing) {
    // Work on a copy so Cancel really cancels.
    const sub = existing
      ? JSON.parse(JSON.stringify(existing))
      : { id: uid(), name: "", freq: "day", n: 1, notes: false, remind: false, times: ["09:00"], options: defaultOptions(), created: todayKey() };

    const body = h("div");
    const draw = () => {
      body.replaceChildren(
        h("div", { class: "field" }, h("label", {}, "Name"),
          h("input", { type: "text", placeholder: "e.g. Take vitamins", value: sub.name, oninput: (e) => { sub.name = e.target.value; } })),

        h("div", { class: "field" }, h("div", { class: "lbl" }, "How often"),
          h("div", { class: "row" },
            stepper(sub.n, 1, sub.freq === "day" ? 6 : 7, (v) => { sub.n = v; draw(); }),
            h("span", {}, "per"),
            choice([{ value: "day", label: "Day" }, { value: "week", label: "Week" }], sub.freq,
              (v) => { sub.freq = v; sub.n = clamp(sub.n, 1, v === "day" ? 6 : 7); draw(); }))),

        h("div", { class: "field" }, h("div", { class: "lbl" }, "Completion levels"),
          sub.options.map((o, i) => h("div", { class: "row optrow" },
            h("input", { type: "text", value: o.label, placeholder: "Label", oninput: (e) => { o.label = e.target.value; } }),
            choice([{ value: "full", label: "Done" }, { value: "partial", label: "Kinda" }], o.level, (v) => { o.level = v; draw(); }, true),
            sub.options.length > 1 ? h("button", { class: "ghost small", "aria-label": "Remove", onclick: () => { sub.options.splice(i, 1); draw(); } }, "✕") : null)),
          h("button", { class: "ghost small", onclick: () => { sub.options.push({ id: "o" + uid(), label: "", level: "partial" }); draw(); } }, "+ Add a level"),
          h("p", { class: "hint" }, "Each tap moves to the next level, then back to empty (not done). Whether a level counts as Done or Kinda decides how it shows in the tracker.")),

        h("div", { class: "field" },
          toggle("Let me add notes", sub.notes, (v) => { sub.notes = v; }),
          toggle("Send me reminders", sub.remind, (v) => { sub.remind = v; draw(); }),
          sub.remind ? [
            sub.times.map((t, i) => h("div", { class: "row optrow" },
              h("input", { type: "time", value: t, onchange: (e) => { sub.times[i] = e.target.value || "09:00"; } }),
              sub.times.length > 1 ? h("button", { class: "ghost small", onclick: () => { sub.times.splice(i, 1); draw(); } }, "✕") : null)),
            h("button", { class: "ghost small", onclick: () => { sub.times.push("18:00"); draw(); } }, "+ Add a time"),
            h("p", { class: "hint" }, "You'll get a notification at each time, unless it's already done."),
          ] : null));
    };
    draw();

    const close = openSheet(
      h("h2", {}, existing ? "Edit sub-goal" : "New sub-goal"),
      body,
      h("div", { class: "btns" },
        h("button", { class: "ghost", onclick: () => close() }, "Cancel"),
        h("button", { class: "ghost primary", onclick: () => {
          sub.name = sub.name.trim();
          if (!sub.name) { alertSheet("Give it a name first."); return; }
          sub.options.forEach((o) => { o.label = o.label.trim() || "Done"; });
          if (existing) habit.subs[habit.subs.indexOf(existing)] = sub; else habit.subs.push(sub);
          save(); close(); render();
        } }, "Save")),
      existing ? h("button", { class: "ghost danger wide", style: "margin:12px 0 0", onclick: () => {
        confirmSheet(`Delete "${existing.name}" and its history?`, "Delete", () => {
          habit.subs = habit.subs.filter((s) => s !== existing);
          forgetSubLog([existing.id]);
          save(); close(); render();
        });
      } }, "Delete sub-goal") : null);
  }

  // ---------- backup ----------
  function backupBox() {
    const file = h("input", { type: "file", accept: "application/json,.json", style: "display:none", onchange: (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      f.text().then((txt) => {
        let s;
        try { s = JSON.parse(txt); if (!s || !Array.isArray(s.habits)) throw new Error("bad"); }
        catch (err) { alertSheet("That file doesn't look like a habits backup."); return; }
        confirmSheet("Replace everything in the app with this backup?", "Replace", () => { state = fromSaved(s); save(); render(); });
      });
    } });
    return h("div", { class: "card", style: "--hc:var(--line)" },
      h("div", { class: "card-head" }, h("h2", {}, "Backup")),
      h("div", { class: "sub" }, h("div", { class: "sub-meta" }, "Your habits live only on this phone. Save a backup now and then, in case the phone is lost or reset.")),
      h("div", { class: "card-foot" },
        h("button", { class: "ghost small", onclick: exportBackup }, "Save backup"),
        h("button", { class: "ghost small", onclick: () => file.click() }, "Restore backup"), file));
  }

  async function exportBackup() {
    const name = `backup-${todayKey()}.json`;
    const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
    const f = new File([blob], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
  }

  // ---------- page 2: tracker ----------
  function trackerPage() {
    const page = h("div");
    page.append(h("div", { class: "top" },
      h("h1", {}, "Tracker"),
      choice([{ value: "week", label: "Week" }, { value: "month", label: "Month" }], trackMode, (v) => { trackMode = v; anchor = selDay; render(); })));

    if (!state.habits.length) {
      page.append(h("div", { class: "empty" }, "Add some habits first, then they'll show up here."));
      return page;
    }

    const today = todayKey();
    const first = earliestStart();
    let label, from, to, canBack, canFwd, goBack, goFwd;

    if (trackMode === "week") {
      from = weekStart(anchor); to = addDays(from, 6);
      const sameMonth = parseKey(from).getMonth() === parseKey(to).getMonth();
      label = `${fmt(from, { day: "numeric", month: "short" })} – ${fmt(to, sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" })}`;
      canBack = from > weekStart(first);
      canFwd = from < weekStart(today);
      goBack = () => { anchor = addDays(from, -7); };
      goFwd = () => { anchor = addDays(from, 7); };
    } else {
      const d = parseKey(anchor), y = d.getFullYear(), m = d.getMonth();
      from = dateKey(new Date(y, m, 1)); to = dateKey(new Date(y, m + 1, 0));
      label = fmt(from, { month: "long", year: "numeric" });
      const f = parseKey(first), t = parseKey(today);
      canBack = y * 12 + m > f.getFullYear() * 12 + f.getMonth();
      canFwd = y * 12 + m < t.getFullYear() * 12 + t.getMonth();
      goBack = () => { anchor = dateKey(new Date(y, m - 1, 1)); };
      goFwd = () => { anchor = dateKey(new Date(y, m + 1, 1)); };
    }
    const move = (fn) => () => { fn(); const ps = trackMode === "week" ? weekStart(anchor) : dateKey(new Date(parseKey(anchor).getFullYear(), parseKey(anchor).getMonth(), 1));
      const pe = trackMode === "week" ? addDays(ps, 6) : dateKey(new Date(parseKey(ps).getFullYear(), parseKey(ps).getMonth() + 1, 0));
      selDay = today >= ps && today <= pe ? today : ps; render(); };

    page.append(h("div", { class: "month" },
      h("button", { class: "ghost", "aria-label": "Earlier", disabled: !canBack, onclick: move(goBack) }, "‹"),
      h("div", { class: "label" }, label),
      h("button", { class: "ghost", "aria-label": "Later", disabled: !canFwd, onclick: move(goFwd) }, "›")));

    const big = trackMode === "week";
    const grid = h("div", { class: "grid" });
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d) => grid.append(h("div", { class: "dow" }, d)));
    if (!big) {
      const offset = (parseKey(from).getDay() + 6) % 7;
      for (let i = 0; i < offset; i++) grid.append(h("div", { class: "day blank" }));
    }
    for (let k = from; k <= to; k = addDays(k, 1)) grid.append(dayCell(k, big, today));
    page.append(grid);

    page.append(h("div", { class: "legend" }, state.habits.map((hb) => h("span", { style: `--hc:${hb.color}` }, h("i"), hb.name || "Untitled"))));
    page.append(h("div", { class: "key" }, "Solid = done · stripes = partly done · dotted outline = not done"));

    const weeks = [];
    for (let ws = weekStart(from); ws <= to; ws = addDays(ws, 7)) if (ws <= today) weeks.push(ws);
    const weekly = weeklySection(weeks, trackMode === "month");
    if (weekly) page.append(weekly);

    page.append(dayDetail());
    return page;
  }

  // Weekly goals live in their own strip: one box per required time, filled in as the week goes.
  function weeklySection(weeks, showLabels) {
    const box = h("div", { class: "weekly" }, h("h3", {}, "Weekly goals"));
    let any = false;
    for (const hb of state.habits) for (const s of weeklySubs(hb)) {
      const rows = weeks.filter((ws) => addDays(ws, 6) >= s.created);
      if (!rows.length) continue;
      any = true;
      box.append(h("div", { class: "wgoal", style: `--hc:${hb.color}` },
        h("div", { class: "wname" }, h("i"), s.name, h("small", {}, `${hb.name || "Untitled"} · ${freqText(s)}`)),
        rows.map((ws) => h("div", { class: "wrow" },
          showLabels ? h("span", { class: "wlabel" }, `${fmt(ws, { day: "numeric", month: "short" })}`) : null,
          h("div", { class: "wboxes" }, weekBoxes(s, ws).map((st) => h("span", { class: "slice fixed s-" + st }))),
          h("span", { class: "wcount" }, `${weekTicks(s, ws).length}/${s.n}`)))));
    }
    return any ? box : null;
  }

  // The bar for one habit on one day: a slice per daily sub-goal.
  function dayBar(hb, k, future) {
    const subs = dailySubs(hb);
    if (!subs.length) return null;
    return h("div", { class: "bar", style: `--hc:${hb.color}` },
      subs.map((s) => h("span", { class: "slice s-" + (future ? "na" : subDay(s, k)) })));
  }

  function dayCell(k, big, today) {
    const future = k > today;
    return h("button", {
      class: "day" + (big ? " big" : "") + (k === today ? " today" : "") + (k === selDay ? " sel" : ""),
      "aria-label": k, onclick: () => { selDay = k; render(); },
    },
      h("div", { class: "n" }, parseKey(k).getDate()),
      state.habits.map((hb) => dayBar(hb, k, future)));
  }

  function dayDetail() {
    const box = h("div", { class: "detail" }, h("h3", {}, fmt(selDay, { weekday: "long", day: "numeric", month: "long" })));
    for (const hb of state.habits) {
      box.append(h("div", { class: "hrow", style: `--hc:${hb.color}` }, h("i"), hb.name || "Untitled"));
      if (!hb.subs.length) box.append(h("div", { class: "srow" }, h("span", {}, "No sub-goals")));
      for (const s of hb.subs) {
        if (selDay < s.created) { box.append(h("div", { class: "srow" }, h("span", {}, s.name), h("span", {}, "not started"))); continue; }
        const marks = marksOf(selDay, s);
        const parts = [];
        for (let i = 0; i < slotsFor(s); i++) { const o = optOf(s, marks[i]); parts.push(o ? o.label : "—"); }
        if (s.freq === "week") parts.push(`(${weekTicks(s, weekStart(selDay)).length}/${s.n} that week)`);
        box.append(h("div", { class: "srow" }, h("span", {}, s.name), h("span", {}, parts.join(" "))));
        const e = entryOf(selDay, s);
        if (e && e.note) box.append(h("div", { class: "note" }, `“${e.note}”`));
      }
    }
    return box;
  }

  // ---------- notifications ----------
  // The reminder job (see worker/) does the actual sending; here we subscribe this phone to it
  // and keep it told about the schedule and what's already done today.
  const PUSH_URL = "https://daily-push.tm-apps.workers.dev"; // address of the deployed reminder job
  const VAPID_PUBLIC = "BB9Q5PRn8qjHvenbZBjCiQpnvTm1syJsuqp2Aj8zx-VMZYycAqrQhskyRvfXR6S_EJPnWY_32ILwFSyHGji7iPg";
  let pushState = "unavailable"; // unavailable | needs-install | unsupported | blocked | off | on

  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = () => navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  const keyBytes = (s) => {
    const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  async function currentSub() {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function refreshPushState() {
    let next;
    if (!PUSH_URL) next = "unavailable";
    else if (isIOS() && !isStandalone()) next = "needs-install";
    else if (!("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)) next = "unsupported";
    else if (Notification.permission === "denied") next = "blocked";
    else {
      try { next = Notification.permission === "granted" && (await currentSub()) ? "on" : "off"; } catch (e) { next = "unsupported"; }
    }
    if (next !== pushState) { pushState = next; if (!document.querySelector(".overlay")) render(); }
  }

  async function pushPost(path, body) {
    const res = await fetch(PUSH_URL + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Everything the job needs: reminder times, the check-in, and what's already done today.
  function syncPayload(sub) {
    const today = todayKey();
    const items = [], skipIds = [];
    let pending = 0;
    for (const hb of state.habits) for (const s of hb.subs) {
      const marks = marksOf(today, s);
      const done = s.freq === "day"
        ? Array.from({ length: s.n }, (_, i) => marks[i]).every(Boolean)
        : marks.some(Boolean) || weekTicks(s, weekStart(today)).length >= s.n;
      if (!done) pending++;
      if (s.remind && s.times && s.times.length) {
        items.push({ id: s.id, title: s.name, body: hb.name || "", times: s.times });
        if (done) skipIds.push(s.id);
      }
    }
    return {
      subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      items, checkin: state.checkin, skip: { date: today, ids: skipIds, allDone: pending === 0 },
    };
  }

  let syncTimer = 0;
  function scheduleSync() {
    if (pushState !== "on") return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 1500);
  }
  async function syncNow() {
    if (pushState !== "on") return;
    try {
      const sub = await currentSub();
      if (sub) await pushPost("/sync", syncPayload(sub));
    } catch (e) { /* offline: it tries again next time the app opens */ }
  }

  async function enablePush() {
    try {
      if ((await Notification.requestPermission()) !== "granted") { await refreshPushState(); render(); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription())
        || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) }));
      await pushPost("/sync", syncPayload(sub));
      pushState = "on";
      render();
    } catch (e) {
      alertSheet("Couldn't turn on notifications. Check your connection and try again.");
    }
  }

  async function disablePush() {
    try {
      const sub = await currentSub();
      if (sub) { const endpoint = sub.endpoint; await sub.unsubscribe(); pushPost("/unsubscribe", { endpoint }).catch(() => {}); }
    } catch (e) { /* already off */ }
    pushState = "off";
    render();
  }

  async function testPush() {
    try {
      const sub = await currentSub();
      await pushPost("/sync", syncPayload(sub));
      await pushPost("/test", { endpoint: sub.endpoint });
      alertSheet("Sent. It should arrive in a few seconds.");
    } catch (e) {
      alertSheet("The test didn't go through. Check your connection and try again.");
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshPushState().then(syncNow);
  });

  // ---------- start ----------
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // If the app was left open overnight, roll over to the new day.
  let lastToday = todayKey();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !document.querySelector(".overlay")) {
      const t = todayKey();
      if (t !== lastToday) { lastToday = t; selDay = t; anchor = t; render(); }
    }
  });
  render();
  refreshPushState().then(syncNow);
})();
