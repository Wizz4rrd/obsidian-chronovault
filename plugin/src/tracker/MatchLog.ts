import { normalizePath, Notice, TFile } from "obsidian";
import type ChronoVaultPlugin from "../../main";
import { addLogRow, cellLabel, extraColumns, formatLogRow, linkTarget, logColumns, logTableHeader, Match, parseLog, rewriteLogRow, tally, upgradeLog } from "../data/matches";
import { MatchFormat, nextRound, parseFormat } from "../data/tournament";

/** A game of the match log, with its deck note when the deck cell links to one. */
export interface LoggedGame {
	match: Match;
	file: TFile | null;
	/** Groups games by deck: the note's path, or the deck cell's text without a note. */
	deckKey: string;
	deckName: string;
	/** The tournament report the event cell links to. */
	event: TFile | null;
	/** What the event cell shows (the report's name), or "" without an event. */
	eventName: string;
	/** The row as it is in the note. */
	raw: string;
}

const DEFAULT_LOG_NAME = "Match log.md";

/** Reads and writes the match log note (see data/matches for its format). */
export class MatchLog {
	constructor(private plugin: ChronoVaultPlugin) {}

	/** The log note's path: the "Match log" setting, or "Match log.md" in the notes folder. */
	get path(): string {
		const set = this.plugin.settings.matchLog.trim();
		const folder = this.plugin.settings.notesFolder.trim();
		const path = set || (folder ? `${folder}/${DEFAULT_LOG_NAME}` : DEFAULT_LOG_NAME);
		return normalizePath(path.toLowerCase().endsWith(".md") ? path : `${path}.md`);
	}

	file(): TFile | null {
		return this.plugin.app.vault.getFileByPath(this.path);
	}

	/** Every game, oldest first (by date, then by row order); `invalid` lists rows that couldn't be read. */
	async games(): Promise<{ games: LoggedGame[]; invalid: number[] }> {
		const file = this.file();
		if (!file) return { games: [], invalid: [] };
		const { rows, invalid } = parseLog(await this.plugin.app.vault.cachedRead(file));
		const resolve = (cell: string) => {
			const target = linkTarget(cell);
			return target ? this.plugin.app.metadataCache.getFirstLinkpathDest(target, file.path) : null;
		};
		// A type typed in another case ("ladder") is the one of the settings, so the stats don't split it in two.
		const types = new Map(this.plugin.settings.matchTypes.map((t) => [t.name.toLowerCase(), t.name]));
		const games = rows.map((row): LoggedGame => {
			const deck = resolve(row.deck);
			const name = deck?.basename ?? cellLabel(row.deck);
			const event = row.match.event ? resolve(row.match.event) : null;
			const match = { ...row.match, type: types.get(row.match.type.toLowerCase()) ?? row.match.type };
			return { match, file: deck, deckKey: deck?.path ?? name, deckName: name || "(no deck)", event, eventName: event?.basename ?? cellLabel(row.match.event), raw: row.raw };
		});
		// Stable: games of the same day keep their row order.
		games.sort((a, b) => (a.match.date || "").localeCompare(b.match.date || ""));
		return { games, invalid };
	}

	/**
	 * What the form starts with for a new game: the patch, type and event of the
	 * last game logged this session, else the patch of the newest game with one
	 * and the type and event of the newest game. Opponent and archetype change
	 * nearly every game, so they start blank. The round is suggested by the form.
	 */
	defaults(games: LoggedGame[]): Partial<Match> {
		const last = this.plugin.lastLogged;
		if (last) return { ...last };
		const newest = games[games.length - 1]?.match;
		return { patch: games.filter((g) => g.match.patch).pop()?.match.patch ?? "", type: newest?.type ?? "", event: newest?.event ?? "" };
	}

	/** The format of a tournament report (its `format` property), or null. */
	eventFormat(event: TFile): MatchFormat | null {
		return parseFormat(this.plugin.app.metadataCache.getFileCache(event)?.frontmatter?.format);
	}

	/** The round of the next game played in `event`, from its games logged so far. */
	suggestRound(games: LoggedGame[], event: TFile): number {
		return nextRound(
			games.filter((g) => g.event === event).map((g) => g.match),
			this.eventFormat(event),
		);
	}

	/** The deck the form starts with for a new game: the deck of the newest game whose note is still in the deck picker. */
	lastDeck(games: LoggedGame[]): TFile | null {
		const decks = this.plugin.deckNotes();
		for (let i = games.length - 1; i >= 0; i--) {
			const file = games[i].file;
			if (file && decks.includes(file)) return file;
		}
		return null;
	}

	async add(deck: TFile, match: Match): Promise<void> {
		const file = await this.ensure();
		await this.plugin.app.vault.process(file, (text) => {
			const upgraded = upgradeLog(text, extraColumns(match));
			return addLogRow(upgraded, formatLogRow(this.linkCell(deck), match, logColumns(upgraded)));
		});
		this.plugin.lastLogged = { patch: match.patch, type: match.type, event: match.event };
		const record = tally((await this.games()).games.filter((g) => g.file === deck).map((g) => g.match));
		new Notice(`ChronoVault: ${match.result === "W" ? "win" : "loss"} logged for ${deck.basename} (now ${record.wins}–${record.losses}).`);
	}

	async update(game: LoggedGame, deck: TFile, match: Match): Promise<void> {
		await this.rewrite(game, (columns, previous) => formatLogRow(this.linkCell(deck), match, columns, previous), extraColumns(match));
	}

	async remove(game: LoggedGame): Promise<void> {
		await this.rewrite(game, null);
	}

	async open(): Promise<void> {
		const file = await this.ensure();
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
	}

	/** Replace the game's row with `next` (given the table's columns and the row), or remove it when `next` is null. */
	private async rewrite(game: LoggedGame, next: ((columns: string[], previous: string) => string) | null, extra: string[] = []): Promise<void> {
		const file = this.file();
		let found = false;
		if (file) {
			await this.plugin.app.vault.process(file, (text) => {
				// The row is found as it is now, and the table gets any missing column first.
				const out = rewriteLogRow(text, game.raw, next, extra);
				found = out !== null;
				return out ?? text;
			});
		}
		if (!found) new Notice("ChronoVault: that game is no longer in the match log (was it edited by hand?).");
	}

	/**
	 * A link to a deck note or tournament report, written the way the vault's "Files and links" settings say (wikilink or Markdown, path format).
	 * With "Deck names in the match log", a link with a path shows the note's name: "[[Decks/Egg Novice|Egg Novice]]".
	 */
	linkCell(note: TFile): string {
		const link = this.plugin.app.fileManager.generateMarkdownLink(note, this.path);
		if (!this.plugin.settings.matchLogDeckAlias || linkTarget(link) === note.basename) return link;
		return this.plugin.app.fileManager.generateMarkdownLink(note, this.path, undefined, note.basename);
	}

	private async ensure(): Promise<TFile> {
		const existing = this.file();
		if (existing) return existing;
		const path = this.path;
		const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (folder && !this.plugin.app.vault.getFolderByPath(folder)) await this.plugin.app.vault.createFolder(folder);
		const intro =
			"# Match log\n\n" +
			"```chrono-matches\n```\n\n" +
			"Games logged with the ChronoVault match tracker, one row per game. You can edit the table by hand: " +
			"Result is W or L, Opponent lists the syndicates.\n\n";
		return this.plugin.app.vault.create(path, `${intro}${logTableHeader()}\n`);
	}
}
