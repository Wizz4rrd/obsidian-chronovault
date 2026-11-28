import { decodeDeck } from "./DeckCodec";
import { unwrapDeckCode } from "./deckInput";
import { Match, MatchRecord, MatchResult, tally } from "./matches";
import { Deck } from "./types";

/** The `type` property of tournament reports. */
export const TOURNAMENT_NOTE_TYPE = "chrono-tournament";

/** Games per match: best of 1, 3 or 5. */
export type MatchFormat = "Bo1" | "Bo3" | "Bo5";

export const MATCH_FORMATS: MatchFormat[] = ["Bo1", "Bo3", "Bo5"];

export function gamesPerMatch(format: MatchFormat): number {
	return format === "Bo5" ? 5 : format === "Bo3" ? 3 : 1;
}

/** A report's `format` property ("Bo3", "bo3", "BO3") as a format; null when it isn't one. */
export function parseFormat(value: unknown): MatchFormat | null {
	if (typeof value !== "string") return null;
	return MATCH_FORMATS.find((f) => f.toLowerCase() === value.trim().toLowerCase()) ?? null;
}

export interface RoundResult {
	round: number;
	/** The round's games, in log order. */
	games: Match[];
	record: MatchRecord;
	/** Who won the match, or null while it is still going (or without a known format). */
	result: MatchResult | null;
}

/** The match of each round, by round; games without a round are left out. */
export function roundResults(games: Match[], format: MatchFormat | null): RoundResult[] {
	const byRound = new Map<number, Match[]>();
	for (const g of games) if (g.round) byRound.set(g.round, [...(byRound.get(g.round) ?? []), g]);
	// Best of 3: the first to 2 wins.
	const needed = format ? Math.ceil(gamesPerMatch(format) / 2) : null;
	return Array.from(byRound, ([round, list]): RoundResult => {
		const record = tally(list);
		const result = needed === null ? null : record.wins >= needed ? "W" : record.losses >= needed ? "L" : null;
		return { round, games: list, record, result };
	}).sort((a, b) => a.round - b.round);
}

/** Matches won and lost: rounds whose result is known. */
export function matchRecord(rounds: RoundResult[]): MatchRecord {
	const wins = rounds.filter((r) => r.result === "W").length;
	const losses = rounds.filter((r) => r.result === "L").length;
	return { wins, losses, games: wins + losses };
}

/**
 * The round of the next game of an event: the round of its last game while that
 * match is still going, else the one after. Without a known format, every game
 * is its own round (like Bo1).
 */
export function nextRound(games: Match[], format: MatchFormat | null): number {
	const last = games.filter((g) => g.round).pop()?.round;
	if (!last) return 1;
	const round = roundResults(games, format ?? "Bo1").find((r) => r.round === last);
	return round && round.result === null ? last : last + 1;
}

/**
 * The "Rounds" section of a tournament report: one heading per round, with a
 * row per game (as many as a match can last) to note which deck was played.
 */
export function tournamentRounds(format: MatchFormat, rounds: number): string {
	const games = gamesPerMatch(format);
	const out: string[] = [];
	for (let r = 1; r <= Math.max(1, rounds); r++) {
		out.push(`### Round ${r}`, "**Opponent:** ", games > 1 ? "**Result:** (e.g. 2-1)" : "**Result:** ", "");
		out.push("| Game | My deck | Their deck | Result | On the play? | Notes |", "| --: | --- | --- | --- | --- | --- |");
		for (let g = 1; g <= games; g++) out.push(`| ${g} |  |  |  |  |  |`);
		out.push("");
	}
	return out.join("\n");
}

/** Decks pasted as codes (one per line), for decks that have no note. `invalid` lists the 1-based lines that aren't deck codes. */
export function parseDeckCodes(text: string): { decks: Deck[]; invalid: number[] } {
	const decks: Deck[] = [];
	const invalid: number[] = [];
	text.split("\n").forEach((line, i) => {
		const code = unwrapDeckCode(line);
		if (!code) return;
		try {
			const d = decodeDeck(code);
			decks.push({ name: d.name.trim() || `Deck ${decks.length + 1}`, divers: d.divers, entries: d.entries });
		} catch {
			invalid.push(i + 1);
		}
	});
	return { decks, invalid };
}
