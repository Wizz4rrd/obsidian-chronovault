import { TFile } from "obsidian";
import { unwrapDeckCode } from "../data/deckInput";
import { Match, MatchResult, today } from "../data/matches";
import { Syndicate, SYNDICATES } from "../data/types";
import { renderSyndicateIcon } from "../ui/SyndicateIcon";

export interface MatchFormOptions {
	decks: TFile[];
	/** Preselected deck; with `lockDeck`, the deck picker is hidden. */
	deck: TFile | null;
	lockDeck?: boolean;
	/** Archetypes logged before, suggested while typing. */
	archetypes: string[];
	/** Patches logged before, newest first, suggested while typing. */
	patches: string[];
	/** The syndicates of a deck code's Divers, or null when it isn't a valid code. */
	codeSyndicates: (code: string) => Syndicate[] | null;
	/** Match types to pick from (the "Match types" setting). */
	types: string[];
	tournament: TournamentFields;
	/** Opponent and archetype of the last game and the latest patch, kept for the next one; a whole game when editing it. */
	initial?: Partial<Match>;
	/** Editing a game: its result button is highlighted. */
	editing?: boolean;
	onSubmit: (file: TFile, match: Match) => void | Promise<void>;
}

/** What the form needs for tournament games: which types are tournaments, the reports to pick from and the round to suggest. */
export interface TournamentFields {
	isType: (type: string) => boolean;
	/** Tournament reports, newest first. */
	reports: TFile[];
	/** The report an event cell links to. */
	resolve: (cell: string) => TFile | null;
	/** The event cell for a report (a link). */
	cell: (report: TFile) => string;
	suggestRound: (report: TFile) => number;
}

let formCount = 0;
/** Event picker value for an event cell that doesn't link to a report (kept as written). */
const RAW_EVENT = "\u0000raw";

/**
 * Deck, type (with the tournament report and round for a tournament type),
 * opponent's syndicates (up to two), optional archetype / date / patch /
 * opponent's deck code / note, and Win / Loss buttons that record the game.
 * Shared by the match tracker and the "Record match result" modal.
 */
export function renderMatchForm(parent: HTMLElement, opts: MatchFormOptions): { focus: () => void } {
	const form = parent.createDiv({ cls: "chrono-match-form" });
	let deck: TFile | null = opts.deck ?? opts.decks[0] ?? null;
	let opponent: Syndicate[] = (opts.initial?.opponent ?? []).slice();

	const row = (label: string, parent: HTMLElement = form) => {
		const r = parent.createDiv({ cls: "chrono-match-row" });
		r.createDiv({ cls: "chrono-match-label", text: label });
		return r.createDiv({ cls: "chrono-match-field" });
	};

	if (!opts.lockDeck) {
		const field = row("Deck");
		if (!opts.decks.length) field.createSpan({ cls: "chrono-match-hint", text: "No deck notes yet. Create one with “New deck note”." });
		else {
			const select = field.createEl("select", { cls: "dropdown" });
			for (const f of opts.decks) select.createEl("option", { text: f.basename, value: f.path });
			if (deck) select.value = deck.path;
			select.addEventListener("change", () => (deck = opts.decks.find((f) => f.path === select.value) ?? null));
		}
	}

	// Type: the settings' types, plus the game's own when editing one whose type isn't in them.
	let type = opts.initial?.type ?? "";
	const types = opts.types.slice();
	if (type && !types.some((t) => t.toLowerCase() === type.toLowerCase())) types.push(type);
	type = types.find((t) => t.toLowerCase() === type.toLowerCase()) ?? "";
	if (types.length) {
		const select = row("Type").createEl("select", { cls: "dropdown", attr: { "aria-label": "Match type" } });
		select.createEl("option", { value: "", text: "None" });
		for (const t of types) select.createEl("option", { value: t, text: t });
		select.value = type;
		select.addEventListener("change", () => {
			type = select.value;
			syncType();
		});
	}

	// Event and round, shown for a tournament type, and kept when editing a game whose
	// type isn't one but that has an event anyway (e.g. typed by hand in the log).
	const tour = opts.tournament;
	const initialEvent = opts.initial?.event ?? "";
	const keepEvent = !!opts.editing && !!(initialEvent || opts.initial?.round) && !tour.isType(opts.initial?.type ?? "");
	const eventBox = form.createDiv({ cls: "chrono-match-event" });
	const eventField = row("Event", eventBox);
	const event = eventField.createEl("select", { cls: "dropdown", attr: { "aria-label": "Tournament report" } });
	event.createEl("option", { value: "", text: "None" });
	for (const f of tour.reports) event.createEl("option", { value: f.path, text: f.basename });
	const initialReport = initialEvent ? tour.resolve(initialEvent) : null;
	if (initialReport && !tour.reports.includes(initialReport)) event.createEl("option", { value: initialReport.path, text: initialReport.basename });
	if (initialEvent && !initialReport) event.createEl("option", { value: RAW_EVENT, text: initialEvent });
	event.value = initialReport?.path ?? (initialEvent ? RAW_EVENT : "");
	if (!tour.reports.length) eventField.createDiv({ cls: "chrono-match-hint", text: "No tournament reports yet. Create one with “New tournament report”." });
	const report = (): TFile | null => (event.value && event.value !== RAW_EVENT ? (tour.reports.find((f) => f.path === event.value) ?? initialReport) : null);
	const round = row("Round", eventBox).createEl("input", { type: "number", cls: "chrono-match-input chrono-match-round", attr: { min: "1", step: "1", placeholder: "1" } });
	const suggest = () => {
		const r = report();
		round.value = r ? String(tour.suggestRound(r)) : "";
	};
	if (opts.editing) round.value = opts.initial?.round ? String(opts.initial.round) : "";
	else suggest();
	event.addEventListener("change", suggest);
	const showEvent = () => tour.isType(type) || keepEvent;
	const eventCell = (): string => {
		if (!showEvent()) return "";
		if (event.value === RAW_EVENT) return initialEvent;
		const r = report();
		return r ? tour.cell(r) : "";
	};
	function syncType(): void {
		// The newest report is most likely the one being played.
		if (tour.isType(type) && !event.value && tour.reports.length && !opts.editing) {
			event.value = tour.reports[0].path;
			suggest();
		}
		eventBox.toggle(showEvent());
	}
	syncType();

	const oppField = row("Opponent");
	const chips = oppField.createDiv({ cls: "chrono-match-synds" });
	const buttons = new Map<Syndicate, HTMLButtonElement>();
	const syncChips = () => buttons.forEach((b, s) => b.toggleClass("is-active", opponent.includes(s)));
	for (const s of SYNDICATES) {
		const b = chips.createEl("button", { cls: ["chrono-syndicate-btn", `chrono-synd-${s.toLowerCase()}`], attr: { type: "button", "aria-label": s } });
		renderSyndicateIcon(b, s);
		b.createSpan({ cls: "chrono-match-synd-name", text: s });
		b.addEventListener("click", () => {
			if (opponent.includes(s)) opponent = opponent.filter((x) => x !== s);
			// A deck has at most two syndicates: a third replaces the oldest pick.
			else opponent = [...opponent, s].slice(-2);
			syncChips();
		});
		buttons.set(s, b);
	}
	syncChips();

	const archetype = archetypeInput(row("Archetype"), opts.initial?.archetype ?? "", opts.archetypes);

	const more = form.createEl("details", { cls: "chrono-match-more" });
	const summary = more.createEl("summary", { text: "Date, patch, opponent's deck, note" });
	const summaryHint = summary.createSpan({ cls: "chrono-match-hint" });
	const moreRow = (label: string) => {
		const r = more.createDiv({ cls: "chrono-match-row" });
		r.createDiv({ cls: "chrono-match-label", text: label });
		return r.createDiv({ cls: "chrono-match-field" });
	};
	const date = moreRow("Date").createEl("input", { type: "date", cls: "chrono-match-input" });
	date.value = opts.initial?.date || today();

	const patchField = moreRow("Patch");
	const patchListId = `chrono-patches-${++formCount}`;
	const patch = patchField.createEl("input", { type: "text", cls: "chrono-match-input", attr: { placeholder: "e.g. 0.11.1", list: patchListId } });
	patch.value = opts.initial?.patch ?? "";
	const patchList = patchField.createEl("datalist", { attr: { id: patchListId } });
	for (const p of opts.patches) patchList.createEl("option", { value: p });
	const syncSummary = () => summaryHint.setText(patch.value.trim() ? ` · patch ${patch.value.trim()}` : "");
	patch.addEventListener("input", syncSummary);
	syncSummary();

	const codeField = moreRow("Opp. deck");
	const code = codeField.createEl("input", { type: "text", cls: "chrono-match-input", attr: { placeholder: "Opponent's deck code, optional", spellcheck: "false" } });
	code.value = opts.initial?.opponentDeck ?? "";
	const codeHint = codeField.createDiv({ cls: "chrono-match-hint" });
	code.addEventListener("input", () => {
		const value = code.value.trim();
		if (!value) return void codeHint.setText("");
		const synds = opts.codeSyndicates(value);
		if (!synds) return void codeHint.setText("Not a valid deck code.");
		// The Divers say which syndicates the opponent played.
		if (synds.length) {
			opponent = synds.slice(0, 2);
			syncChips();
		}
		codeHint.setText(synds.length ? `Opponent set to ${synds.join(" + ")} from the Divers.` : "");
	});

	const note = moreRow("Note").createEl("input", { type: "text", cls: "chrono-match-input", attr: { placeholder: "Optional" } });
	note.value = opts.initial?.note ?? "";
	if (opts.editing) more.open = true;

	const actions = form.createDiv({ cls: "chrono-match-results" });
	const submit = async (result: MatchResult) => {
		if (!deck) return;
		await opts.onSubmit(deck, {
			date: date.value || today(),
			patch: patch.value.trim(),
			result,
			opponent: opponent.slice(),
			archetype: archetype(),
			opponentDeck: unwrapDeckCode(code.value).replace(/\s+/g, ""),
			type,
			event: eventCell(),
			round: showEvent() ? Math.max(0, Math.floor(Number(round.value))) || null : null,
			note: note.value.trim(),
		});
		if (!opts.editing) {
			note.value = code.value = "";
			codeHint.setText("");
		}
	};
	const resultBtn = (result: MatchResult, label: string, cls: string) => {
		const b = actions.createEl("button", { cls: ["chrono-match-result", cls], text: label, attr: { type: "button" } });
		if (opts.editing && opts.initial?.result === result) b.addClass("is-current");
		b.addEventListener("click", () => void submit(result));
	};
	resultBtn("W", opts.editing ? "Save as win" : "Win", "is-win");
	resultBtn("L", opts.editing ? "Save as loss" : "Loss", "is-loss");

	return { focus: () => buttons.get(opponent[0] ?? SYNDICATES[0])?.focus() };
}

/**
 * Free text, suggesting the archetypes logged before; returns a getter for the
 * value. Typing a known archetype in another case ("aggro") gives its logged
 * spelling ("Aggro"), so the stats don't split it in two.
 */
function archetypeInput(field: HTMLElement, value: string, known: string[]): () => string {
	const listId = `chrono-archetypes-${++formCount}`;
	const input = field.createEl("input", { type: "text", cls: "chrono-match-input", attr: { placeholder: "Optional, e.g. Aggro", list: listId } });
	input.value = value;
	const datalist = field.createEl("datalist", { attr: { id: listId } });
	for (const a of known) datalist.createEl("option", { value: a });
	return () => {
		const typed = input.value.trim().replace(/\s+/g, " ");
		return known.find((a) => a.toLowerCase() === typed.toLowerCase()) ?? typed;
	};
}
