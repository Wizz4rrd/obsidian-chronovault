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
	/** Told when the type, event or deck is picked, so a form drawn again (e.g. the tracker's) can start from them. */
	onPick?: (picked: FormPicks) => void;
}

/** What the form keeps between games: the type, the event (as its log cell) and the deck. */
export interface FormPicks {
	type: string;
	event: string;
	deck: TFile | null;
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
	/** Where a round stands, e.g. "Round 3 of 5: 1–1 so far". */
	status: (report: TFile, round: number) => string;
	/** The opponent's name in a round, from its games already logged. */
	player: (report: TFile, round: number) => string;
	/** The deck notes the report lists. */
	decks: (report: TFile) => TFile[];
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
	let opponent: Syndicate[] = (opts.initial?.opponent ?? []).slice();

	const row = (label: string, parent: HTMLElement = form) => {
		const r = parent.createDiv({ cls: "chrono-match-row" });
		r.createDiv({ cls: "chrono-match-label", text: label });
		return r.createDiv({ cls: "chrono-match-field" });
	};

	// Type: the settings' types, plus the game's own when editing one whose type isn't in them.
	// A new game always gets a type (the first one by default); only a game logged without one keeps "None" when edited.
	let type = opts.initial?.type ?? "";
	const types = opts.types.slice();
	if (type && !types.some((t) => t.toLowerCase() === type.toLowerCase())) types.push(type);
	type = types.find((t) => t.toLowerCase() === type.toLowerCase()) ?? (opts.editing ? "" : (types[0] ?? ""));
	if (types.length) {
		const select = row("Type").createEl("select", { cls: "dropdown", attr: { "aria-label": "Match type" } });
		if (!type) select.createEl("option", { value: "", text: "None" });
		for (const t of types) select.createEl("option", { value: t, text: t });
		select.value = type;
		select.addEventListener("change", () => {
			type = select.value;
			syncType();
			picked();
		});
	}

	// Event, round and the opponent's name, shown for a tournament type, and kept when editing
	// a game whose type isn't one but that has an event anyway (e.g. typed by hand in the log).
	const tour = opts.tournament;
	const initialEvent = opts.initial?.event ?? "";
	const keepEvent = !!opts.editing && !!(initialEvent || opts.initial?.round || opts.initial?.player) && !tour.isType(opts.initial?.type ?? "");
	const showEvent = () => tour.isType(type) || keepEvent;
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
	const report = (): TFile | null => (showEvent() && event.value && event.value !== RAW_EVENT ? (tour.reports.find((f) => f.path === event.value) ?? initialReport) : null);
	const eventCell = (): string => {
		if (!showEvent()) return "";
		if (event.value === RAW_EVENT) return initialEvent;
		const r = report();
		return r ? tour.cell(r) : "";
	};

	const roundField = row("Round", eventBox);
	const round = roundField.createEl("input", { type: "number", cls: "chrono-match-input chrono-match-round", attr: { min: "1", step: "1", placeholder: "1" } });
	const roundHint = roundField.createSpan({ cls: "chrono-match-hint chrono-match-round-status" });
	const roundNumber = () => Math.max(0, Math.floor(Number(round.value))) || null;
	const player = row("Player", eventBox).createEl("input", { type: "text", cls: "chrono-match-input", attr: { placeholder: "Opponent's name, optional" } });
	player.value = opts.initial?.player ?? "";
	// The name is filled in from the round's earlier games, until it's typed by hand.
	let playerTyped = !!opts.editing;
	player.addEventListener("input", () => (playerTyped = true));
	const syncRound = () => {
		const r = report();
		const n = roundNumber();
		roundHint.setText(r && n ? tour.status(r, n) : "");
		if (!playerTyped) player.value = r && n ? tour.player(r, n) : "";
	};
	const suggest = () => {
		const r = report();
		round.value = r ? String(tour.suggestRound(r)) : "";
		syncRound();
	};
	round.addEventListener("input", syncRound);
	event.addEventListener("change", () => {
		if (!opts.editing) playerTyped = false;
		suggest();
		fillDecks();
		picked();
	});

	// Deck: for a tournament game, the decks the report lists (when it lists any).
	const deckField = opts.lockDeck ? null : row("Deck");
	let deck: TFile | null = opts.deck ?? null;
	function fillDecks(): void {
		const r = report();
		const brought = r ? tour.decks(r) : [];
		const list = brought.length ? brought.slice() : opts.decks.slice();
		// A game being edited keeps its deck, even if the report doesn't list it.
		if (opts.editing && deck && !list.includes(deck)) list.push(deck);
		if (!opts.lockDeck && (!deck || !list.includes(deck))) deck = list[0] ?? null;
		if (!deckField) return;
		deckField.empty();
		if (!list.length) return void deckField.createSpan({ cls: "chrono-match-hint", text: "No deck notes yet. Create one with “New deck note”." });
		const select = deckField.createEl("select", { cls: "dropdown", attr: { "aria-label": "Deck" } });
		for (const f of list) select.createEl("option", { text: f.basename, value: f.path });
		if (deck) select.value = deck.path;
		select.addEventListener("change", () => {
			deck = list.find((f) => f.path === select.value) ?? null;
			picked();
		});
		if (brought.length) deckField.createDiv({ cls: "chrono-match-hint", text: "The decks listed in the tournament report." });
	}

	function picked(): void {
		opts.onPick?.({ type, event: eventCell(), deck });
	}

	function syncType(): void {
		// The newest report is most likely the one being played.
		if (tour.isType(type) && !event.value && tour.reports.length && !opts.editing) event.value = tour.reports[0].path;
		eventBox.toggle(showEvent());
		if (opts.editing) {
			round.value = opts.initial?.round ? String(opts.initial.round) : "";
			syncRound();
		} else suggest();
		fillDecks();
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
			round: showEvent() ? roundNumber() : null,
			player: showEvent() ? player.value.trim().replace(/\s+/g, " ") : "",
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
