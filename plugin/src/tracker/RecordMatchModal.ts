import { Modal, TFile } from "obsidian";
import type ChronoVaultPlugin from "../../main";
import { comparePatches, Match } from "../data/matches";
import { LoggedGame } from "./MatchLog";
import { MatchFormOptions, renderMatchForm } from "./MatchForm";

/** The form options that come from the plugin and the games logged so far (all but the deck and the game). */
export function matchFormOptions(plugin: ChronoVaultPlugin, games: LoggedGame[]): Pick<MatchFormOptions, "archetypes" | "patches" | "codeSyndicates" | "types" | "tournament"> {
	const log = plugin.matchLog;
	return {
		archetypes: uniqueArchetypes(games.map((g) => g.match.archetype)),
		patches: uniquePatches(games.map((g) => g.match.patch)),
		codeSyndicates: (code) => plugin.codeSyndicates(code),
		types: plugin.settings.matchTypes.map((t) => t.name),
		tournament: {
			isType: (type) => plugin.isTournamentType(type),
			reports: plugin.tournamentNotes(),
			resolve: (cell) => log.resolveEvent(cell),
			cell: (report) => log.linkCell(report),
			suggestRound: (report) => log.suggestRound(games, report),
			status: (report, round) => log.roundStatus(games, report, round),
			player: (report, round) => log.roundPlayer(games, report, round),
			decks: (report) => log.reportDecks(report),
		},
	};
}

/**
 * The match form in a modal: "Record match result" (new game, from anywhere),
 * editing a game from the match tracker, or logging a game of a tournament
 * report (from the report, with its event and a tournament type preset).
 */
export class RecordMatchModal extends Modal {
	constructor(
		private plugin: ChronoVaultPlugin,
		private deck: TFile | null,
		private editing?: LoggedGame,
		private report?: TFile,
	) {
		super(plugin.app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText(this.editing ? "Edit game" : "Record match result");
		this.modalEl.addClass("chrono-match-modal");
		const { games } = await this.plugin.matchLog.games();
		const form = renderMatchForm(this.contentEl, {
			...matchFormOptions(this.plugin, games),
			decks: this.plugin.deckNotes(),
			deck: this.editing?.file ?? this.deck ?? this.plugin.matchLog.lastDeck(games),
			initial: this.editing?.match ?? this.initial(games),
			editing: !!this.editing,
			onSubmit: async (file, match) => {
				await this.save(file, match);
				this.close();
			},
		});
		form.focus();
	}

	private initial(games: LoggedGame[]): Partial<Match> {
		return newGameDefaults(this.plugin, games, this.report ?? null);
	}

	private async save(file: TFile, match: Match): Promise<void> {
		if (this.editing) await this.plugin.matchLog.update(this.editing, file, match);
		else await this.plugin.matchLog.add(file, match);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** A new game's defaults; for a game of `report`, its event and a tournament type (the last one used, else the first). */
export function newGameDefaults(plugin: ChronoVaultPlugin, games: LoggedGame[], report: TFile | null): Partial<Match> {
	const defaults = plugin.matchLog.defaults(games);
	if (!report) return defaults;
	const type = plugin.isTournamentType(defaults.type ?? "") ? defaults.type : plugin.settings.matchTypes.find((t) => t.tournament)?.name;
	return { ...defaults, type: type ?? defaults.type, event: plugin.matchLog.linkCell(report) };
}

export function uniqueArchetypes(names: string[]): string[] {
	const seen = new Map<string, string>();
	for (const n of names) if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
	return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

/** Patches logged before, newest first. */
export function uniquePatches(patches: string[]): string[] {
	return Array.from(new Set(patches.filter(Boolean))).sort(comparePatches);
}

