import { Modal, TFile } from "obsidian";
import type ChronoVaultPlugin from "../../main";
import { comparePatches, linkTarget, Match } from "../data/matches";
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
			resolve: (cell) => {
				const target = linkTarget(cell);
				return target ? plugin.app.metadataCache.getFirstLinkpathDest(target, log.path) : null;
			},
			cell: (report) => log.linkCell(report),
			suggestRound: (report) => log.suggestRound(games, report),
		},
	};
}

/**
 * The match form in a modal: "Record match result" (new game, from anywhere)
 * or editing a game from the match tracker.
 */
export class RecordMatchModal extends Modal {
	constructor(
		private plugin: ChronoVaultPlugin,
		private deck: TFile | null,
		private editing?: LoggedGame,
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
			initial: this.editing?.match ?? this.plugin.matchLog.defaults(games),
			editing: !!this.editing,
			onSubmit: async (file, match) => {
				await this.save(file, match);
				this.close();
			},
		});
		form.focus();
	}

	private async save(file: TFile, match: Match): Promise<void> {
		if (this.editing) await this.plugin.matchLog.update(this.editing, file, match);
		else await this.plugin.matchLog.add(file, match);
	}

	onClose(): void {
		this.contentEl.empty();
	}
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

