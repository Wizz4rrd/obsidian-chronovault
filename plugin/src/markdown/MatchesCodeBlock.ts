import { debounce, MarkdownRenderChild, setIcon, TFile } from "obsidian";
import type ChronoVaultPlugin from "../../main";
import { deckNoteFrontmatter } from "../templates/DeckNoteSync";
import { RecordMatchModal } from "../tracker/RecordMatchModal";
import { formatRecord, groupRecords, pairingLabel, parseTypes, typeLabel } from "../data/matches";
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
		log.addEventListener("click", () => new RecordMatchModal(this.plugin, deck).open());
		const open = bar.createEl("button");
		setIcon(open.createSpan(), "trophy");
		open.appendText(" Open match tracker");
		open.addEventListener("click", () => void this.plugin.activateMatchTracker(deck));

		if (this.types.length) {
			const names = this.types.map((t) => logged.find((g) => typeLabel(g.match).toLowerCase() === t)?.match.type || this.plugin.settings.matchTypes.find((m) => m.name.toLowerCase() === t)?.name || t);
			el.createDiv({ cls: "chrono-match-hint", text: `Type: ${names.join(", ")}` });
		}
		if (!games.length) {
			const none = deck
				? "No games logged for this deck yet."
				: report
					? "No games logged for this tournament yet. Log a game with a tournament type and pick this report as the event."
					: "No games logged yet.";
			el.createDiv({ cls: "chrono-match-hint", text: none });
			return;
		}
		if (report) return this.renderReport(report, games);
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

	/** A tournament report's games: the record, the match of each round and the record of each deck. */
	private renderReport(report: TFile, games: LoggedGame[]): void {
		const el = this.containerEl;
		const matches = games.map((g) => g.match);
		const format = this.plugin.matchLog.eventFormat(report);
		const rounds = roundResults(matches, format);
		renderKpis(el, matches);
		if (rounds.length) {
			const matchesWon = matchRecord(rounds);
			const going = rounds.filter((r) => r.result === null).length;
			const summary = [format ? `${format}, matches ${formatRecord(matchesWon)}` : "No format in the report's properties", going && format ? `${going} round${going === 1 ? "" : "s"} still going` : ""];
			el.createDiv({ cls: "chrono-match-hint", text: summary.filter(Boolean).join(" · ") });

			const table = el.createDiv({ cls: "chrono-match-table-wrap" }).createEl("table", { cls: "chrono-match-table chrono-match-rounds" });
			const head = table.createEl("thead").createEl("tr");
			for (const h of ["Round", "Deck", "Opponent", "Games", "Result"]) head.createEl("th", { text: h });
			const body = table.createEl("tbody");
			for (const r of rounds) {
				const roundGames = games.filter((g) => g.match.round === r.round);
				const tr = body.createEl("tr");
				tr.createEl("td", { cls: "chrono-match-num", text: String(r.round) });
				tr.createEl("td", { text: Array.from(new Set(roundGames.map((g) => g.deckName))).join(", ") });
				// The opponent's syndicates of the round's games (the same player, usually the same deck).
				const pairings = Array.from(new Set(roundGames.map((g) => pairingLabel(g.match.opponent))));
				const opp = tr.createEl("td");
				for (const p of pairings) renderPairing(opp, pairingFromLabel(p));
				renderFormStrip(tr.createEl("td"), r.games, r.games.length);
				const result = tr.createEl("td", { cls: "chrono-match-num" });
				if (r.result) renderResultChip(result, r.result);
				result.appendText(` ${formatRecord(r.record)}`);
			}
		}
		const noRound = games.filter((g) => !g.match.round).length;
		if (noRound) el.createDiv({ cls: "chrono-match-hint", text: `${noRound} game${noRound === 1 ? "" : "s"} without a round.` });

		const decks = groupRecords(games, (g) => g.deckName, (g) => g.match);
		if (decks.length > 1) renderRecordTable(el, ["Deck"], decks.map((d) => ({ label: (td) => void td.setText(d.key), record: d.record })));
	}
}
