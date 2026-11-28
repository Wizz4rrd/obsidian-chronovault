import { debounce, MarkdownRenderChild, setIcon, TFile } from "obsidian";
import type ChronoVaultPlugin from "../../main";
import { deckNoteFrontmatter } from "../templates/DeckNoteSync";
import { RecordMatchModal } from "../tracker/RecordMatchModal";
import { renderTextWithCardRefs } from "./InlineCardRef";
import { formatRecord, groupRecords, pairingLabel, parseTypes, tally, typeLabel } from "../data/matches";
import { matchRecord, roundResults, TOURNAMENT_NOTE_TYPE } from "../data/tournament";
import { LoggedGame } from "../tracker/MatchLog";
import { pairingFromLabel, renderFormStrip, renderKpis, renderPairing, renderRecordTable, renderResultChip } from "../tracker/MatchWidgets";

/**
 * ```chrono-matches```: the match tracker's numbers inside a note.
 * In a deck note, that deck's results: win rate, record, form and the record
 * against each syndicate pair. In a tournament report, the games played in it:
 * the match of each round and the record of each deck. Anywhere else (e.g. the
 * match log), every game. All with buttons to log a game and open the tracker.
 *
 * A `type: Ladder, Scrim` line keeps only games of those types ("No type" for
 * games without one).
 */
export function registerMatchesCodeBlock(plugin: ChronoVaultPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("chrono-matches", (source, el, ctx) => {
		ctx.addChild(new MatchesBlock(el, plugin, ctx.sourcePath, parseTypes(source)));
	});
}

const FORM_GAMES = 10;

class MatchesBlock extends MarkdownRenderChild {
	private refreshSoon = debounce(() => void this.render(), 300, true);

	constructor(
		containerEl: HTMLElement,
		private plugin: ChronoVaultPlugin,
		private sourcePath: string,
		private types: string[],
	) {
		super(containerEl);
	}

	onload(): void {
		const { vault } = this.plugin.app;
		this.registerEvent(vault.on("modify", (file) => file.path === this.plugin.matchLog.path && this.refreshSoon()));
		this.registerEvent(vault.on("create", (file) => file.path === this.plugin.matchLog.path && this.refreshSoon()));
		this.registerEvent(vault.on("rename", () => this.refreshSoon()));
		// A tournament report's format sets how its rounds are counted.
		this.registerEvent(this.plugin.app.metadataCache.on("changed", (file) => file.path === this.sourcePath && this.refreshSoon()));
		void this.render();
	}

	/** The deck note this block is in, or null outside a deck note. */
	private deck(): TFile | null {
		const file = this.plugin.app.vault.getFileByPath(this.sourcePath);
		return file && deckNoteFrontmatter(this.plugin.app, file) ? file : null;
	}

	/** The tournament report this block is in, or null outside one. */
	private report(): TFile | null {
		const file = this.plugin.app.vault.getFileByPath(this.sourcePath);
		return file && this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.type === TOURNAMENT_NOTE_TYPE ? file : null;
	}

	private async render(): Promise<void> {
		const deck = this.deck();
		const report = deck ? null : this.report();
		const { games: logged } = await this.plugin.matchLog.games();
		const all = this.types.length ? logged.filter((g) => this.types.includes(typeLabel(g.match).toLowerCase())) : logged;
		const games = deck ? all.filter((g) => g.file?.path === deck.path) : report ? all.filter((g) => g.event?.path === report.path) : all;
		const el = this.containerEl;
		el.empty();
		el.addClass("chrono-matches-block");

		const bar = el.createDiv({ cls: "chrono-matches-bar" });
		const log = bar.createEl("button", { cls: "mod-cta" });
		setIcon(log.createSpan(), "plus");
		log.appendText(" Log a game");
		log.addEventListener("click", () => new RecordMatchModal(this.plugin, deck, undefined, report ?? undefined).open());
		const open = bar.createEl("button");
		setIcon(open.createSpan(), "trophy");
		open.appendText(" Open match tracker");
		open.addEventListener("click", () => void this.plugin.activateMatchTracker(deck, report));

		if (this.types.length) {
			const names = this.types.map((t) => logged.find((g) => typeLabel(g.match).toLowerCase() === t)?.match.type || this.plugin.settings.matchTypes.find((m) => m.name.toLowerCase() === t)?.name || t);
			el.createDiv({ cls: "chrono-match-hint", text: `Type: ${names.join(", ")}` });
		}
		if (report) return this.renderReport(report, games);
		if (!games.length) {
			el.createDiv({ cls: "chrono-match-hint", text: deck ? "No games logged for this deck yet." : "No games logged yet." });
			return;
		}
		const matches = games.map((g) => g.match);
		renderKpis(el, matches);
		const strip = el.createDiv({ cls: "chrono-tracker-strip" });
		strip.createSpan({ cls: "chrono-match-hint", text: `Last ${Math.min(FORM_GAMES, matches.length)}` });
		renderFormStrip(strip, matches, FORM_GAMES);
		if (deck) {
			renderRecordTable(
				el,
				["Syndicate pair"],
				groupRecords(matches, (m) => pairingLabel(m.opponent), (m) => m).map((p) => ({ label: (td) => void renderPairing(td, pairingFromLabel(p.key)), record: p.record })),
			);
		}
	}

	/**
	 * A tournament report's rounds, from the games logged for it: the match and
	 * game records, then a row per round (planned rounds not played yet included)
	 * with the opponent, the deck, the games and their notes, and the result.
	 */
	private renderReport(report: TFile, games: LoggedGame[]): void {
		const el = this.containerEl;
		const info = this.plugin.matchLog.reportInfo(report);
		const matches = games.map((g) => g.match);
		// Without a format, rounds count as Bo1, like the round the form suggests and the `record` written.
		const rounds = roundResults(matches, info.format ?? "Bo1");
		const hint = (text: string) => el.createDiv({ cls: "chrono-match-hint", text });
		if (!info.format) hint("No format property (Bo1, Bo3 or Bo5) in this report: rounds are counted as Bo1.");

		const kpis = el.createDiv({ cls: "chrono-match-kpis" });
		const kpi = (label: string, value: string) => {
			const k = kpis.createDiv({ cls: "chrono-match-kpi" });
			k.createDiv({ cls: "chrono-match-kpi-value", text: value });
			k.createDiv({ cls: "chrono-match-kpi-label", text: label });
		};
		kpi("Matches", formatRecord(matchRecord(rounds)));
		kpi("Games", formatRecord(tally(matches)));
		if (info.format) kpi("Format", info.format);
		const played = rounds.length ? rounds[rounds.length - 1].round : 0;
		if (info.rounds) kpi("Rounds", `${Math.min(played, info.rounds)} of ${info.rounds}`);

		const last = Math.max(played, info.rounds ?? 0);
		if (!last) {
			hint("No games logged for this tournament yet. Use “Log a game” above: its event is this report.");
			return;
		}
		const table = el.createDiv({ cls: "chrono-match-table-wrap" }).createEl("table", { cls: "chrono-match-table chrono-match-rounds" });
		const head = table.createEl("thead").createEl("tr");
		for (const h of ["Round", "Opponent", "Deck", "Games", "Result", "Notes"]) head.createEl("th", { text: h });
		const body = table.createEl("tbody");
		for (let n = 1; n <= last; n++) {
			const r = rounds.find((x) => x.round === n);
			const roundGames = games.filter((g) => g.match.round === n);
			const tr = body.createEl("tr");
			tr.createEl("td", { cls: "chrono-match-num", text: String(n) });
			if (!r) {
				tr.addClass("is-empty");
				tr.createEl("td", { cls: "chrono-match-hint", text: "Not played yet", attr: { colspan: "5" } });
				continue;
			}
			// The same player all round, usually with the same deck.
			const opp = tr.createEl("td");
			const players = unique(roundGames.map((g) => g.match.player));
			if (players.length) opp.createSpan({ cls: "chrono-match-player", text: players.join(", ") });
			for (const p of unique(roundGames.map((g) => pairingLabel(g.match.opponent)))) renderPairing(opp, pairingFromLabel(p), !players.length);
			tr.createEl("td", { text: unique(roundGames.map((g) => g.deckName)).join(", ") });
			renderFormStrip(tr.createEl("td"), r.games, r.games.length);
			const result = tr.createEl("td", { cls: "chrono-match-num" });
			if (r.result) renderResultChip(result, r.result);
			result.appendText(` ${formatRecord(r.record)}${r.result ? "" : ", going"}`);
			const notes = tr.createEl("td", { cls: "chrono-match-note" });
			renderTextWithCardRefs(this.plugin, notes, roundGames.map((g) => g.match.note).filter(Boolean).join(" · "));
		}
		const noRound = games.filter((g) => !g.match.round).length;
		if (noRound) hint(`${noRound} game${noRound === 1 ? "" : "s"} without a round (not in the table, counted in Games).`);

		const decks = groupRecords(games, (g) => g.deckName, (g) => g.match);
		if (decks.length > 1) renderRecordTable(el, ["Deck"], decks.map((d) => ({ label: (td) => void td.setText(d.key), record: d.record })));
	}
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}
